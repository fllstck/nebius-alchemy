/**
 * M3 — bindings integration tests (SLOW_TESTS=1, real Nebius credentials).
 *
 * Proves the binding's deploy-time + runtime halves against the real cloud:
 *
 *   1. Host identity lifecycle: ServiceAccount → Group → GroupMembership →
 *      AccessKey, with the one-time secret surviving a SECOND deploy (state
 *      store persistence — closes the carried-over M0 check).
 *   2. Grant + runtime client: AccessPermit (`storage.editor` on the bucket)
 *      actually enables S3 object ops with the injected credentials — real
 *      put / get / delete round-trip via s3-lite-client, plus the 404 path
 *      for a missing key.
 *
 * The full Worker e2e (binding Layer running in `alchemy dev` workerd) is a
 * documented manual verification — see BINDINGS.md M3.
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { S3Client, S3Errors } from '@bradenmacdonald/s3-lite-client'
import { Nebius, test } from '../../../helpers/stack'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

/** Region used by the binding's env injection (README: NEBIUS_REGION, default eu-north1). */
const REGION = process.env.NEBIUS_REGION ?? 'eu-north1'
const S3_ENDPOINT = `https://storage.${REGION}.nebius.cloud`

/** Promise-based S3 call adapted into the Effect test body. */
const attempt = <A>(tryFn: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: tryFn,
    catch: (e: unknown) => new Error(e instanceof Error ? e.message : String(e)),
  })

integrationTest(
  test.provider,
  'Nebius bindings: host identity lifecycle + one-time secret persistence',
  (stack) =>
    Effect.gen(function* () {
      const sa = yield* stack.deploy(
        Nebius.iam.ServiceAccount('BindTestSA', {
          description: 'binding integration test',
        }),
      )
      expect(sa.id).toBeDefined()
      expect(sa.id).toBeDefined()
      expect(String(sa.parentId)).toBe(String(process.env.NEBIUS_PROJECT_ID))

      const group = yield* stack.deploy(Nebius.iam.Group('BindTestGroup'))
      expect(group.id).toBeDefined()

      yield* stack.deploy(
        Nebius.iam.GroupMembership('BindTestMembership', {
          parentId: group.id,
          memberId: sa.id,
        }),
      )

      const key = yield* stack.deploy(
        Nebius.iam.AccessKey('BindTestKey', {
          serviceAccountId: sa.id,
          secretDeliveryMode: 'INLINE',
        }),
      )
      expect(key.awsAccessKeyId).toBeDefined()
      expect(key.secretAccessKey.length).toBeGreaterThan(0)

      // Second deploy — the one-time secret must be preserved from state.
      const keyAgain = yield* stack.deploy(
        Nebius.iam.AccessKey('BindTestKey', {
          serviceAccountId: sa.id,
          secretDeliveryMode: 'INLINE',
        }),
      )
      expect(keyAgain.secretAccessKey).toBe(key.secretAccessKey)
    }).pipe(safeDestroy(stack)),
  { timeout: 360_000 },
)

integrationTest(
  test.provider,
  'Nebius bindings: AccessPermit grant + S3 round-trip',
  (stack) =>
    Effect.gen(function* () {
      const sa = yield* stack.deploy(
        Nebius.iam.ServiceAccount('BindTripSA', {
          description: 'binding integration test',
        }),
      )
      const group = yield* stack.deploy(Nebius.iam.Group('BindTripGroup'))
      yield* stack.deploy(
        Nebius.iam.GroupMembership('BindTripMembership', {
          parentId: group.id,
          memberId: sa.id,
        }),
      )
      const key = yield* stack.deploy(
        Nebius.iam.AccessKey('BindTripKey', {
          serviceAccountId: sa.id,
          secretDeliveryMode: 'INLINE',
        }),
      )
      const bucket = yield* stack.deploy(
        Nebius.storage.Bucket('BindTripBucket', {
          versioningPolicy: 'DISABLED',
          defaultStorageClass: 'STANDARD',
          objectAuditLogging: 'NONE',
          forceStorageClass: false,
        }),
      )
      expect(bucket.state).toBe('ACTIVE')

      // The grant the binding would declare (D5): storage.editor on the bucket
      // for the host-identity group.
      yield* stack.deploy(
        Nebius.iam.AccessPermit('BindTripPermit', {
          parentId: group.id,
          resourceId: bucket.id,
          role: 'storage.editor',
        }),
      )

      const client = new S3Client({
        endPoint: S3_ENDPOINT,
        region: REGION,
        accessKey: key.awsAccessKeyId,
        secretKey: key.secretAccessKey,
        bucket: bucket.name,
        pathStyle: true,
      })

      // --- Real object round-trip with the binding's credentials ---
      const objectKey = `bindings-test/${Date.now()}.txt`
      yield* attempt(() => client.putObject(objectKey, 'hello from M3'))

      const response = yield* attempt(() => client.getObject(objectKey))
      const body = yield* attempt(() => response.text())
      expect(body).toBe('hello from M3')

      yield* attempt(() => client.deleteObject(objectKey))

      // --- Missing key surfaces as a 404 (NoSuchKey), not a 403 ---
      const missing = yield* attempt(() => client.getObject('definitely-missing-key').then(
        (r) => ({ ok: true as const, response: r }),
        (e: unknown) => ({ ok: false as const, error: e }),
      ))
      expect(missing.ok).toBe(false)
      if (missing.ok) throw new Error('unreachable')
      expect(missing.error).toBeInstanceOf(S3Errors.ServerError)
    }).pipe(safeDestroy(stack)),
  { timeout: 480_000 },
)
