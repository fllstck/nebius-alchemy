/**
 * M3 integration tests for the storage bindings.
 *
 * 1. Identity lifecycle: SA → default editors-group membership → v2 access
 *    key with INLINE secret (create + destroy).
 * 2. S3 round-trip: the full binding chain — bucket + SA → editors grant →
 *    access key → s3-lite-client (the same client the Worker binding uses) →
 *    PutObject/GetObject round-trip against real Nebius S3.
 * 3. Binding impl end-to-end: the REAL GetObjectHttp/PutObjectHttp
 *    layers with a mocked Worker host — deploy-time wiring (hostIdentity →
 *    grant → env bindings) + the runtime client (readS3Env → s3-lite-client).
 *
 * PATTERN (see agent-patterns/alchemy-test-patterns.md): the scratch stack
 * re-plans on every deploy and DELETES resources absent from the new effect.
 * Stage 1 deploys dependencies (bucket + SA) alone; stage 2 re-declares them
 * (noop) plus the dependent resources, referencing the SA via the in-effect
 * resource instance.
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { expect } from 'bun:test'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { Worker, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Self } from 'alchemy/Self'
import * as StorageGrpc from '../../../../modules/api-client/storage.ts'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'

const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m'
const REGION = process.env.NEBIUS_REGION ?? 'eu-north1'
// Empty string → the server's default project scope (the profile's project,
// where these tests deploy). NEBIUS_PROJECT_ID, if set, MUST be that same
// project — pointing it elsewhere silently blinds the leak check below.
const PROJECT = process.env.NEBIUS_PROJECT_ID ?? ''

/**
 * Post-destroy leak verification for buckets: any `nebius-storage-*` bucket
 * surviving the destroy is a leak (the bucket delete has no force option — a
 * non-empty bucket is undeletable, so leftovers accumulate silently).
 */
const verifyNoBucketLeaks = Effect.gen(function* () {
  const storage = yield* StorageGrpc.StorageGrpcService
  const buckets = yield* storage.bucket.list(PROJECT)
  const leaked = buckets.filter((b) => b.metadata?.name?.startsWith('nebius-storage-'))
  if (leaked.length > 0) {
    return yield* Effect.fail(
      new Error(`LEAKED buckets after destroy: ${leaked.map((b) => b.metadata?.name).join(', ')}`),
    )
  }
})

// ---------------------------------------------------------------------------
// Test 1 — identity lifecycle
// ---------------------------------------------------------------------------

integrationTest(
  test.provider,
  'Nebius.iam identity lifecycle (SA → editors membership → access key)',
  (stack) =>
    Effect.gen(function* () {
      // Stage 1: SA alone — its id becomes concrete state for later stages.
      const { sa } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('BindingSA', {
            description: 'bindings integration test SA',
          })
          return { sa }
        }),
      )
      expect(sa.id).toMatch(/^serviceaccount-/)

      // Stage 2: re-declare the SA (noop — not deleted) + dependents, refs
      // through the in-effect resource instance (dependency edge for destroy).
      const { membership, key } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('BindingSA', {
            description: 'bindings integration test SA',
          })
          const membership = yield* Nebius.iam.GroupMembership('BindingMembership', {
            parentId: EDITORS_GROUP_ID as never,
            memberId: sa.id,
          })
          const key = yield* Nebius.iam.AccessKey('BindingKey', {
            serviceAccountId: sa.id,
            secretDeliveryMode: 'INLINE',
          })
          return { membership, key }
        }),
      )

      expect(membership.id).toMatch(/^groupmembership-/)
      expect(key.id).toMatch(/^accesskey-/)
      expect(key.serviceAccountId).toBe(sa.id)
      expect(key.awsAccessKeyId.length).toBeGreaterThan(0)
      expect(key.secretAccessKey.length).toBeGreaterThan(0)
      expect(key.secretDeliveryMode).toBe('INLINE')
      console.log(`[BIND] SA: ${sa.id} key: ${key.awsAccessKeyId}`)
    }).pipe(safeDestroy(stack, verifyNoBucketLeaks)),
  { timeout: 120_000 },
)

// ---------------------------------------------------------------------------
// Test 2 — S3 round-trip via the binding's runtime client
// ---------------------------------------------------------------------------

const OBJECT_KEY = 'bindings/roundtrip.txt'
const PAYLOAD = 'hello from the nebius bindings round-trip'

integrationTest(
  test.provider,
  'Nebius.storage bindings — S3 round-trip via s3-lite-client',
  (stack) =>
    Effect.gen(function* () {
      // Stage 1: dependencies alone — bucket + SA (no cross-deps).
      const { bucket, sa } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Nebius.storage.Bucket('RoundtripBucket', {
            versioningPolicy: 'DISABLED',
            defaultStorageClass: 'STANDARD',
            objectAuditLogging: 'NONE',
            forceStorageClass: false,
          })
          const sa = yield* Nebius.iam.ServiceAccount('RoundtripSA', {
            description: 'bindings round-trip SA',
          })
          return { bucket, sa }
        }),
      )
      expect(bucket.name).toBeDefined()
      expect(sa.id).toMatch(/^serviceaccount-/)
      console.log(`[RT] bucket: ${bucket.name} sa: ${sa.id}`)

      // Stage 2: re-declare bucket + SA (noops) + membership (grant) + key.
      const { key } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Nebius.storage.Bucket('RoundtripBucket', {
            versioningPolicy: 'DISABLED',
            defaultStorageClass: 'STANDARD',
            objectAuditLogging: 'NONE',
            forceStorageClass: false,
          })
          const sa = yield* Nebius.iam.ServiceAccount('RoundtripSA', {
            description: 'bindings round-trip SA',
          })
          // Editors-group membership = the grant: the default editors group
          // carries the `editor` general role (full S3 object access) — no
          // AccessPermit / bucket policy needed (see BINDINGS.md §M3).
          yield* Nebius.iam.GroupMembership('RoundtripMembership', {
            parentId: EDITORS_GROUP_ID as never,
            memberId: sa.id,
          })
          const key = yield* Nebius.iam.AccessKey('RoundtripKey', {
            serviceAccountId: sa.id,
            secretDeliveryMode: 'INLINE',
          })
          return { key }
        }),
      )
      expect(key.awsAccessKeyId.length).toBeGreaterThan(0)
      expect(key.secretAccessKey.length).toBeGreaterThan(0)
      console.log(`[RT] key: ${key.awsAccessKeyId}`)

      // Runtime client — byte-for-byte the client the binding Layer builds
      // (endPoint full URL, path-style, region-scoped key).
      const client = new S3Client({
        endPoint: `https://storage.${REGION}.nebius.cloud`,
        region: REGION,
        accessKey: key.awsAccessKeyId,
        secretKey: key.secretAccessKey,
        bucket: bucket.name,
        pathStyle: true,
      })

      // PutObject → GetObject round-trip. The object delete runs in a
      // finally: any failure (PUT, GET, body read, assertion) must not leave
      // the bucket non-empty — a non-empty bucket is undeletable → silent
      // leak (the delete has no force option).
      yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => client.putObject(OBJECT_KEY, PAYLOAD),
          catch: (e) => Effect.fail(new Error(`putObject failed: ${String(e)}`)),
        })
        console.log('[RT] putObject ok')

        const response = yield* Effect.tryPromise({
          try: () => client.getObject(OBJECT_KEY),
          catch: (e) => Effect.fail(new Error(`getObject failed: ${String(e)}`)),
        })
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (e) => Effect.fail(new Error(`reading body failed: ${String(e)}`)),
        })
        expect(text).toBe(PAYLOAD)
        console.log('[RT] getObject round-trip OK')
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise({
            try: () => client.deleteObject(OBJECT_KEY),
            catch: (e) => Effect.fail(new Error(`deleteObject failed: ${String(e)}`)),
            // Swallow cleanup errors: verifyNoBucketLeaks after destroy is the
            // backstop, and a cleanup failure must not mask the test outcome.
          }).pipe(Effect.catchCause(() => Effect.void)),
        ),
      )
      console.log('[RT] cleanup ok')
    }).pipe(safeDestroy(stack, verifyNoBucketLeaks)),
  { timeout: 180_000 },
)

// ---------------------------------------------------------------------------
// Test 3 — the real binding impl: deploy-time wiring + runtime client
// ---------------------------------------------------------------------------

const BIND_KEY = 'bindings/impl-roundtrip.txt'
const BIND_PAYLOAD = 'through the binding impl'

/** The Worker resource's Self service — the mock host satisfies it. */
// oxlint-disable-next-line no-explicit-any — mock host satisfies the Worker shape
const mockSelf = (host: any) => Layer.succeed(Self('Cloudflare.Worker'), host)

integrationTest(
  test.provider,
  'Nebius.storage bindings — GetObjectHttp impl end-to-end (mocked host)',
  (stack) =>
    Effect.gen(function* () {
      // Stage 1: bucket + a test SA (the SA gives us key material for the
      // runtime env — the worker would receive these values via bindings).
      const { bucket, sa } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Nebius.storage.Bucket('ImplBucket', {
            versioningPolicy: 'DISABLED',
            defaultStorageClass: 'STANDARD',
            objectAuditLogging: 'NONE',
            forceStorageClass: false,
          })
          const sa = yield* Nebius.iam.ServiceAccount('ImplSA', {
            description: 'binding impl test SA',
          })
          return { bucket, sa }
        }),
      )
      console.log(`[IMPL] bucket: ${bucket.name} sa: ${sa.id}`)

      // Stage 2: a test key for the runtime env (the impl's own hostIdentity
      // creates a second identity — that is the wiring under test). The
      // bucket is re-declared (noop) so the re-plan doesn't delete it.
      const keyOut = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Nebius.storage.Bucket('ImplBucket', {
            versioningPolicy: 'DISABLED',
            defaultStorageClass: 'STANDARD',
            objectAuditLogging: 'NONE',
            forceStorageClass: false,
          })
          const sa = yield* Nebius.iam.ServiceAccount('ImplSA', {
            description: 'binding impl test SA',
          })
          yield* Nebius.iam.GroupMembership('ImplMembership', {
            parentId: EDITORS_GROUP_ID as never,
            memberId: sa.id,
          })
          const key = yield* Nebius.iam.AccessKey('ImplKey', {
            serviceAccountId: sa.id,
            secretDeliveryMode: 'INLINE',
          })
          return { key }
        }),
      )
      console.log(`[IMPL] test key: ${keyOut.key.awsAccessKeyId}`)

      // Stage 3: run the REAL binding layers with a mocked Worker host.
      // The impl's deploy-time branch executes: hostIdentity (declares the
      // mock host's SA+group+membership+key in the same effect),
      // grantBucketAccess, bindWorkerEnv → recorded on the mock host.
      // The runtime branch reads the provided WorkerEnvironment (real key
      // values, as a deployed worker would receive them) and round-trips.
      const hostCalls: Array<{ sid: string; data: unknown }> = []
      const mockHost = {
        LogicalId: 'ImplMockHost',
        bind: (sid: string, data: unknown) => {
          hostCalls.push({ sid, data })
          return Effect.void
        },
      } as unknown as Worker

      const runtimeEnv = {
        NEBIUS_S3_ENDPOINT: `https://storage.${REGION}.nebius.cloud`,
        NEBIUS_REGION: REGION,
        NEBIUS_ACCESS_KEY_ID: keyOut.key.awsAccessKeyId,
        NEBIUS_SECRET_ACCESS_KEY: keyOut.key.secretAccessKey,
        NEBIUS_BUCKET_NAME: bucket.name,
      }

      const { readBack } = yield* stack.deploy(
        Effect.gen(function* () {
          // Re-declare the FULL resource set (noops) — the re-plan would
          // otherwise DELETE anything not in this effect (partial-redeploy
          // rule), including the test key we still need for the cleanup.
          yield* Nebius.storage.Bucket('ImplBucket', {
            versioningPolicy: 'DISABLED',
            defaultStorageClass: 'STANDARD',
            objectAuditLogging: 'NONE',
            forceStorageClass: false,
          })
          const sa = yield* Nebius.iam.ServiceAccount('ImplSA', {
            description: 'binding impl test SA',
          })
          yield* Nebius.iam.GroupMembership('ImplMembership', {
            parentId: EDITORS_GROUP_ID as never,
            memberId: sa.id,
          })
          yield* Nebius.iam.AccessKey('ImplKey', {
            serviceAccountId: sa.id,
            secretDeliveryMode: 'INLINE',
          })
          const bucket = yield* Nebius.storage.Bucket('ImplBucket', {
            versioningPolicy: 'DISABLED',
            defaultStorageClass: 'STANDARD',
            objectAuditLogging: 'NONE',
            forceStorageClass: false,
          })
          const getObject = yield* Nebius.storage.GetObject(bucket).pipe(
            Effect.provide(Nebius.storage.GetObjectHttp),
            Effect.provide(mockSelf(mockHost)),
            Effect.provide(Layer.succeed(WorkerEnvironment, runtimeEnv)),
          )
          const putObject = yield* Nebius.storage.PutObject(bucket).pipe(
            Effect.provide(Nebius.storage.PutObjectHttp),
            Effect.provide(mockSelf(mockHost)),
            Effect.provide(Layer.succeed(WorkerEnvironment, runtimeEnv)),
          )

          // PUT + GET through the binding's own runtime client. The object
          // delete runs in a finally: any failure (PUT, GET, body read, or
          // the assertions below) must not leave the bucket non-empty — a
          // non-empty bucket is undeletable → silent leak.
          yield* putObject({ key: BIND_KEY, value: BIND_PAYLOAD, contentType: 'text/plain' })
          const read = yield* getObject({ key: BIND_KEY })
          const text = yield* read.text
          return { readBack: text }
        }).pipe(
          Effect.ensuring(
            Effect.tryPromise({
              try: () =>
                new S3Client({
                  endPoint: `https://storage.${REGION}.nebius.cloud`,
                  region: REGION,
                  accessKey: keyOut.key.awsAccessKeyId,
                  secretKey: keyOut.key.secretAccessKey,
                  bucket: bucket.name,
                  pathStyle: true,
                }).deleteObject(BIND_KEY),
              catch: (e) => Effect.fail(new Error(`deleteObject failed: ${String(e)}`)),
              // Swallow cleanup errors: verifyNoBucketLeaks after destroy is
              // the backstop, and a cleanup failure must not mask the result.
            }).pipe(Effect.catchCause(() => Effect.void)),
          ),
        ),
      )

      expect(readBack).toBe(BIND_PAYLOAD)
      console.log('[IMPL] runtime round-trip through the binding impl OK')

      // The deploy-time wiring must have registered the shared host-identity
      // env on the mock host. registerEnvOnce dedupes by (host, name): the
      // first capability (GetObject) registers all 5 NEBIUS_S3_* names and
      // PutObject's attempt is a no-op (Cloudflare rejects duplicate binding
      // names on a single upload). PutObject's grant is still declared — as
      // an AccessPermit resource in the deploy effect, not a host.bind call.
      expect(hostCalls.length).toBeGreaterThanOrEqual(1)
      const sids = hostCalls.map((c) => c.sid)
      expect(sids).toContain('Nebius.storage.v1.Bucket.GetObject')
      const names = hostCalls.flatMap((c) =>
        // oxlint-disable-next-line no-explicit-any — mock host data shape
        ((c.data as any)?.bindings ?? []).map((b: { name: string }) => b.name),
      )
      for (const expected of [
        'NEBIUS_S3_ENDPOINT',
        'NEBIUS_REGION',
        'NEBIUS_ACCESS_KEY_ID',
        'NEBIUS_SECRET_ACCESS_KEY',
        'NEBIUS_BUCKET_NAME',
      ]) {
        expect(names).toContain(expected)
      }
      console.log(`[IMPL] wiring recorded ${hostCalls.length} bind calls`)
    }).pipe(safeDestroy(stack, verifyNoBucketLeaks)),
  { timeout: 240_000 },
)
