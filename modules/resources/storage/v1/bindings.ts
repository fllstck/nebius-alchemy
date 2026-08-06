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

/** Deploy-time env values injected into the Worker (D7 naming, Redacted secret). */
const bindingEnv = (
  bucketName: Output.Output<string>,
  region: string,
  identity: HostIdentity,
): Record<string, BindHost.EnvValue> => ({
  NEBIUS_S3_ENDPOINT: `https://storage.${region}.nebius.cloud`,
  NEBIUS_REGION: region,
  NEBIUS_ACCESS_KEY_ID: identity.awsAccessKeyId,
  NEBIUS_SECRET_ACCESS_KEY: identity.secretAccessKey,
  NEBIUS_BUCKET_NAME: bucketName,
})

/**
 * The shared host-identity env must be injected ONCE per host: Cloudflare
 * rejects duplicate binding names on a single upload, and every capability
 * (GetObject, PutObject, …) injects the same `NEBIUS_S3_*` values. The first
 * capability registers them; later ones skip the already-registered names.
 *
 * A module-level set is effectively per-deploy: `alchemy deploy` runs one
 * deploy per process, and `alchemy dev` restarts the exec child per reload.
 */
const registeredEnvNames = new Set<string>()

const registerEnvOnce = Effect.fn('registerEnvOnce')(function* (
  host: Worker,
  sid: string,
  env: Record<string, BindHost.EnvValue>,
): Effect.fn.Return<void> {
  const fresh = Object.fromEntries(
    Object.entries(env).filter(([name]) => !registeredEnvNames.has(`${host.LogicalId}:${name}`)),
  )
  if (Object.keys(fresh).length === 0) return
  for (const name of Object.keys(fresh)) registeredEnvNames.add(`${host.LogicalId}:${name}`)
  yield* BindHost.bindWorkerEnv(host, sid, fresh)
})

// ---------------------------------------------------------------------------
// Implementation Layers (Cloudflare Worker host)
// ---------------------------------------------------------------------------

/**
 * GetObject — read an object's content and metadata by key.
 */
export const GetObjectBinding = Layer.effect(
  GetObject,
  Effect.gen(function* () {
    const host = yield* Worker
    const env = yield* WorkerEnvironment

    return Effect.fn(function* (
      bucket: NebiusBucket,
    ): Effect.fn.Return<
      (request: GetObjectRequest) => Effect.Effect<GetObjectResult, StorageError>
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
          `${host.LogicalId}${bucket.LogicalId}GetObjectAccess`,
          identity,
          bucket.id,
          'storage.viewer',
        )
        yield* registerEnvOnce(host, 'Nebius.storage.v1.Bucket.GetObject', bindingEnv(BucketName, region, identity))
      }

      let client: S3Client | undefined
      const getClient = Effect.fn('GetObject.getClient')(function* (): Effect.fn.Return<S3Client, StorageError> {
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

      return Effect.fn('Nebius.storage.Bucket.GetObject')(function* (
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
    })
  }),
)

/**
 * PutObject — write an object's content by key.
 */
export const PutObjectBinding = Layer.effect(
  PutObject,
  Effect.gen(function* () {
    const host = yield* Worker
    const env = yield* WorkerEnvironment

    return Effect.fn(function* (
      bucket: NebiusBucket,
    ): Effect.fn.Return<
      (request: PutObjectRequest) => Effect.Effect<PutObjectResult, StorageError>
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
          `${host.LogicalId}${bucket.LogicalId}PutObjectAccess`,
          identity,
          bucket.id,
          'storage.editor',
        )
        yield* registerEnvOnce(host, 'Nebius.storage.v1.Bucket.PutObject', bindingEnv(BucketName, region, identity))
      }

      let client: S3Client | undefined
      const getClient = Effect.fn('PutObject.getClient')(function* (): Effect.fn.Return<S3Client, StorageError> {
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

      return Effect.fn('Nebius.storage.Bucket.PutObject')(function* (
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
    })
  }),
)
