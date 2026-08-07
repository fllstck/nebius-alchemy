/**
 * M2 — Storage bindings for Cloudflare Worker hosts.
 *
 * Typed runtime clients for `Nebius.storage.Bucket` object operations. One
 * line at the call site yields the capability and derives, at deploy time:
 *
 *   1. a host identity (ServiceAccount + AccessKey + Group — `host-identity.ts`),
 *   2. an AccessPermit granting the host-identity group a role on the bucket,
 *   3. Worker env bindings (endpoint, credentials, bucket name, region).
 *
 * At runtime the client calls Nebius S3 over HTTP via `s3-lite-client`
 * (fetch + WebCrypto — workerd-safe, verified in M0).
 *
 * ⚠️ BUNDLE SAFETY (D8): the deploy-time provisioning (`host-identity.ts`)
 * statically imports gRPC resources. It is loaded here via a guarded
 * `await import()` inside `if (!globalThis.__ALCHEMY_RUNTIME__)` — alchemy's
 * bundler folds the guard to `false` and DCEs the branch + dynamic import out
 * of the Worker bundle entirely (M0-verified: zero gRPC markers). All
 * top-level imports in this file are workerd-safe or type-only.
 */
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Output from 'alchemy/Output'
import * as Schema from 'effect/Schema'
import * as Binding from 'alchemy/Binding'
import { Worker, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Self } from 'alchemy/Self'
import { S3Client, S3Errors, type S3ObjectMetadata } from '@bradenmacdonald/s3-lite-client'
import * as BindHost from '../../shared/bind-host.ts'
import type { HostIdentity } from '../../shared/host-identity.ts'
import type { Region } from '../../regions.schema.ts'
import type { NebiusBucket } from './bucket.ts'
// ---------------------------------------------------------------------------
// Errors (D6) — Schema.TaggedErrorClass, catchable by tag
// ---------------------------------------------------------------------------

/** Local shape of s3-lite-client's `putObject` options (the d.ts type is inline). */
type S3ClientPutOptions = {
  metadata?: S3ObjectMetadata
  size?: number
  bucketName?: string
  partSize?: number
}

/** The object key does not exist in the bucket (S3 `NoSuchKey`). */
export class ObjectNotFound extends Schema.TaggedErrorClass<ObjectNotFound>()('ObjectNotFound', {
  key: Schema.String,
  message: Schema.String,
}) {}

/** The bucket does not exist (S3 `NoSuchBucket`). */
export class BucketNotFound extends Schema.TaggedErrorClass<BucketNotFound>()('BucketNotFound', {
  message: Schema.String,
}) {}

/** The host identity lacks permission for the operation (S3 `AccessDenied`). */
export class AccessDenied extends Schema.TaggedErrorClass<AccessDenied>()('AccessDenied', {
  message: Schema.String,
}) {}

/** Required env bindings are missing at runtime (deploy-time wiring failure). */
export class InvalidCredentials extends Schema.TaggedErrorClass<InvalidCredentials>()('InvalidCredentials', {
  missing: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** Any other S3 server or client failure, with the upstream code preserved. */
export class S3Error extends Schema.TaggedErrorClass<S3Error>()('S3Error', {
  code: Schema.String,
  statusCode: Schema.optional(Schema.Finite),
  message: Schema.String,
}) {}

/** The shared error channel for storage bindings. */
export type StorageError = ObjectNotFound | BucketNotFound | AccessDenied | InvalidCredentials | S3Error

// ---------------------------------------------------------------------------
// Request / result shapes
// ---------------------------------------------------------------------------

export interface GetObjectRequest {
  readonly key: string
}

/**
 * The object content plus response metadata. `body` is the raw stream — pick
 * one consumer: stream `body`, or await `text`/`bytes` (which consume it).
 */
export interface GetObjectResult {
  readonly key: string
  readonly contentType: string | null
  readonly etag: string | null
  readonly size: number | null
  readonly body: ReadableStream<Uint8Array>
  readonly text: Effect.Effect<string, StorageError>
  readonly bytes: Effect.Effect<Uint8Array, StorageError>
}

export interface PutObjectRequest {
  readonly key: string
  readonly value: string | Uint8Array | ReadableStream<Uint8Array>
  readonly contentType?: string
}

export interface PutObjectResult {
  readonly etag: string
  readonly versionId: string | null
}

// ---------------------------------------------------------------------------
// Contracts (Binding.Service)
// ---------------------------------------------------------------------------

export interface GetObject extends Binding.Service<
  GetObject,
  'Nebius.storage.v1.Bucket.GetObject',
  (bucket: NebiusBucket) => Effect.Effect<
    (request: GetObjectRequest) => Effect.Effect<GetObjectResult, StorageError>
  >
> {}

export const GetObject = Binding.Service<GetObject>('Nebius.storage.v1.Bucket.GetObject')

export interface PutObject extends Binding.Service<
  PutObject,
  'Nebius.storage.v1.Bucket.PutObject',
  (bucket: NebiusBucket) => Effect.Effect<
    (request: PutObjectRequest) => Effect.Effect<PutObjectResult, StorageError>
  >
> {}

export const PutObject = Binding.Service<PutObject>('Nebius.storage.v1.Bucket.PutObject')

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

const DEFAULT_REGION: Region = 'eu-north1'

const S3_ENV_NAMES = [
  'NEBIUS_S3_ENDPOINT',
  'NEBIUS_REGION',
  'NEBIUS_ACCESS_KEY_ID',
  'NEBIUS_SECRET_ACCESS_KEY',
  'NEBIUS_BUCKET_NAME',
] as const

/** Literal-keyed env record — keeps property access `string` (noUncheckedIndexedAccess). */
type S3Env = Record<(typeof S3_ENV_NAMES)[number], string>

/** Resolve the injected S3 env values, failing with InvalidCredentials if any are absent. */
export const readS3Env = Effect.fn('readS3Env')(function* (
  env: Readonly<Record<string, unknown>>,
): Effect.fn.Return<S3Env, InvalidCredentials> {
  const missing = S3_ENV_NAMES.filter((name) => typeof env[name] !== 'string')
  if (missing.length > 0) {
    return yield* Effect.fail(
      new InvalidCredentials({
        missing: [...missing],
        message: `Missing Nebius S3 env bindings: ${missing.join(', ')}. Did the binding's deploy-time wiring run?`,
      }),
    )
  }
  const values: S3Env = {
    NEBIUS_S3_ENDPOINT: env.NEBIUS_S3_ENDPOINT as string,
    NEBIUS_REGION: env.NEBIUS_REGION as string,
    NEBIUS_ACCESS_KEY_ID: env.NEBIUS_ACCESS_KEY_ID as string,
    NEBIUS_SECRET_ACCESS_KEY: env.NEBIUS_SECRET_ACCESS_KEY as string,
    NEBIUS_BUCKET_NAME: env.NEBIUS_BUCKET_NAME as string,
  }
  return values
})

/** Build the SigV4 S3 client from resolved env values (path-style for Nebius). */
const makeS3Client = (values: S3Env): S3Client =>
  new S3Client({
    endPoint: values.NEBIUS_S3_ENDPOINT,
    region: values.NEBIUS_REGION,
    accessKey: values.NEBIUS_ACCESS_KEY_ID,
    secretKey: values.NEBIUS_SECRET_ACCESS_KEY,
    bucket: values.NEBIUS_BUCKET_NAME,
    pathStyle: true,
  })

/** Map s3-lite-client errors to the tagged StorageError union (D6). */
export const toStorageError = (key: string | undefined, error: unknown): StorageError => {
  if (error instanceof S3Errors.ServerError) {
    switch (error.code) {
      case 'NoSuchKey':
        return new ObjectNotFound({ key: key ?? error.key ?? '', message: error.message })
      case 'NoSuchBucket':
        return new BucketNotFound({ message: error.message })
      case 'AccessDenied':
        return new AccessDenied({ message: error.message })
      default:
        return new S3Error({ code: error.code, statusCode: error.statusCode, message: error.message })
    }
  }
  if (error instanceof S3Errors.S3Error) {
    return new S3Error({ code: 'ClientError', message: error.message })
  }
  return new S3Error({
    code: 'Unknown',
    message: error instanceof Error ? error.message : String(error),
  })
}

/** Deploy-time env values injected into the Worker (D7 naming; the access key secret deploys as secret_text). */
const bindingEnv = (
  bucketName: Output.Output<string>,
  region: string,
  identity: HostIdentity,
): Record<string, BindHost.EnvValue | BindHost.SecretValue> => ({
  NEBIUS_S3_ENDPOINT: `https://storage.${region}.nebius.cloud`,
  NEBIUS_REGION: region,
  NEBIUS_ACCESS_KEY_ID: identity.awsAccessKeyId,
  NEBIUS_SECRET_ACCESS_KEY: BindHost.secret(identity.secretAccessKey),
  NEBIUS_BUCKET_NAME: bucketName,
})

/**
 * The shared host-identity env must be injected ONCE per host: Cloudflare
 * rejects duplicate binding names on a single upload, and every capability
 * (GetObject, PutObject, …) injects the same `NEBIUS_S3_*` values. The first
 * capability registers them; later ones skip the already-registered names
 * (see `registerEnvOnce` in `shared/bind-host.ts`).
 */

// ---------------------------------------------------------------------------
// Implementation Layers (Cloudflare Worker host)
// ---------------------------------------------------------------------------

/**
 * Shared scaffolding for the `*Http` storage binding layers — the
 * `make…HttpBinding` factory pattern from alchemy (cf.
 * `AWS/IoTWireless/BindingHttp.ts`).
 *
 * The whole per-binding chain lives here once: host + `WorkerEnvironment`
 * resolution, the guarded deploy-time provisioning (host identity → bucket
 * grant → env injection), and the memoized S3 client. Each capability is a
 * thin `Layer.effect` over this factory, supplying the sid/span name, the
 * grant role, and its operation. (Factory returns `Effect.gen` alchemy-style;
 * the ops themselves are `Effect.fn` so every request traces.)
 */
const makeStorageHttpBinding = <Req, A>(options: {
  /** Short capability name — binding sid, grant id, and span names. */
  capability: string
  /** AccessPermit role granted on the bucket (D5: viewer/editor). */
  role: 'storage.viewer' | 'storage.editor'
  /**
   * Build the runtime operation from the memoized client resolver. The op fn
   * owns the request span (`Nebius.storage.Bucket.<capability>`); the bucket
   * is baked into the client, so the request carries no resource id.
   */
  makeRequest: (
    getClient: () => Effect.Effect<S3Client, StorageError, never>,
  ) => (request: Req) => Effect.Effect<A, StorageError, never>
}) =>
  Effect.gen(function* () {
    const host = yield* Worker
    const env = yield* WorkerEnvironment

    return Effect.fn(function* (
      bucket: NebiusBucket,
    ): Effect.fn.Return<
      (request: Req) => Effect.Effect<A, StorageError, never>
    > {
      const BucketName = bucket.name

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const region = yield* Effect.orDie(
          Config.string('NEBIUS_REGION').pipe(Config.withDefault(DEFAULT_REGION)),
        )
        const { hostIdentity, grantBucketAccess } = yield* Effect.promise(
          () => import('../../shared/host-identity.ts'),
        )
        const identity = yield* hostIdentity(host.LogicalId)
        yield* grantBucketAccess(
          `${host.LogicalId}${bucket.LogicalId}${options.capability}Access`,
          identity,
          bucket.id,
          options.role,
        )
        yield* BindHost.registerEnvOnce(
          host,
          `Nebius.storage.v1.Bucket.${options.capability}`,
          bindingEnv(BucketName, region, identity),
        )
      }

      let client: S3Client | undefined
      const getClient = Effect.fn(`${options.capability}.getClient`)(function* (): Effect.fn.Return<S3Client, StorageError> {
        if (client !== undefined) return client
        const values = yield* readS3Env(env)
        const next = yield* Effect.try({
          try: () => makeS3Client(values),
          catch: (e) =>
            new S3Error({
              code: 'InvalidClientConfig',
              message: e instanceof Error ? e.message : String(e),
            }),
        })
        client = next
        return next
      })

      return options.makeRequest(getClient)
    })
  })

/**
 * GetObject operation — read an object's content and metadata by key.
 */
const getObjectRequest = (
  getClient: () => Effect.Effect<S3Client, StorageError, never>,
) =>
  Effect.fn('Nebius.storage.Bucket.GetObject')(function* (
    request: GetObjectRequest,
  ): Effect.fn.Return<GetObjectResult, StorageError> {
    const c = yield* getClient()
    const response = yield* Effect.tryPromise({
      try: () => c.getObject(request.key),
      catch: (e) => toStorageError(request.key, e),
    })
    const length = response.headers.get('content-length')
    return {
      key: request.key,
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
      size: length === null ? null : Number(length),
      body: response.body as ReadableStream<Uint8Array>,
      text: Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => toStorageError(request.key, e),
      }),
      bytes: Effect.tryPromise({
        try: () => response.arrayBuffer(),
        catch: (e) => toStorageError(request.key, e),
      }).pipe(Effect.map((buffer) => new Uint8Array(buffer))),
    }
  })

/**
 * PutObject operation — write an object's content by key.
 */
const putObjectRequest = (
  getClient: () => Effect.Effect<S3Client, StorageError, never>,
) =>
  Effect.fn('Nebius.storage.Bucket.PutObject')(function* (
    request: PutObjectRequest,
  ): Effect.fn.Return<PutObjectResult, StorageError> {
    const c = yield* getClient()
    const options: S3ClientPutOptions = {}
    if (request.contentType !== undefined) {
      options.metadata = { 'Content-Type': request.contentType }
    }
    const info = yield* Effect.tryPromise({
      try: () => c.putObject(request.key, request.value, options),
      catch: (e) => toStorageError(request.key, e),
    })
    return { etag: info.etag, versionId: info.versionId }
  })

/**
 * GetObjectHttp — read an object's content and metadata by key (Cloudflare
 * Worker host: deploy-time grant + env wiring, s3-lite-client at runtime).
 */
export const GetObjectHttp = Layer.effect(
  GetObject,
  makeStorageHttpBinding({
    capability: 'GetObject',
    role: 'storage.viewer',
    makeRequest: getObjectRequest,
  }),
)

/**
 * PutObjectHttp — write an object's content by key (Cloudflare Worker host).
 */
export const PutObjectHttp = Layer.effect(
  PutObject,
  makeStorageHttpBinding({
    capability: 'PutObject',
    role: 'storage.editor',
    makeRequest: putObjectRequest,
  }),
)

// ---------------------------------------------------------------------------
// Async-host wiring helper
// ---------------------------------------------------------------------------

/**
 * Run the deploy-time binding wiring for an ASYNC (non-Effect) Worker host.
 *
 * An Effect-native worker consumes the `*Http` layers inside its impl,
 * where `Self`/`WorkerEnvironment` are in scope. An async worker (`main` +
 * plain `fetch`) can't — so this runs the same layers against the deployed
 * host directly: mints the host identity (SA → editors grant → access key),
 * injects the `NEBIUS_S3_*` env bindings, and registers the bucket grants.
 * The worker then reads `env` at runtime with s3-lite-client.
 *
 * Deploy-time only. The runtime side of the layers is unused by async
 * workers.
 */
export const wireAsyncBindings = Effect.fn('Nebius.storage.v1.Bucket.wireAsyncBindings')(function* (
  host: Worker,
  bucket: NebiusBucket,
): Effect.fn.Return<void> {
  // The layers' impls yield the Worker host via `Self`; provide it with the
  // deployed host. The WorkerEnvironment is only consumed by the layers'
  // runtime side, which async workers don't use — a dummy satisfies the build.
  // The `as` cast erases the layer requirements (Worker/WorkerEnvironment —
  // provided here) plus the contract's Provider requirements, which the
  // stack's providers satisfy at runtime.
  // provideHost erases R: it provides every requirement (Worker host,
  // WorkerEnvironment, HTTP services) itself.
  // oxlint-disable-next-line no-explicit-any
  const provideHost = <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E, never> =>
    effect.pipe(
      Effect.provide(Layer.mergeAll(GetObjectHttp, PutObjectHttp)),
      Effect.provide(Layer.succeed(Self('Cloudflare.Worker'), host)),
      Effect.provide(Layer.succeed(WorkerEnvironment, {})),
    ) as Effect.Effect<A, E, never>

  yield* provideHost(GetObject(bucket))
  yield* provideHost(PutObject(bucket))
})