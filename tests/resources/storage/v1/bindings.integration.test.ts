/**
 * M3 — bindings integration tests (SLOW_TESTS=1, real Nebius credentials).
 *
 * Grant path (per the Nebius docs "How to manage service accounts" + AWS CLI
 * guide): add the host-identity SA to the tenant's pre-created default
 * `editors` group. The group already carries the `editor` general role, so S3
 * access is inherited — no AccessPermit / bucket policy needed, and (verified)
 * the membership resolves INSTANTLY for a fresh SA because the group is
 * pre-existing (the fresh-group + fresh-SA pair is what lags).
 *
 *   1. Host identity lifecycle: SA → default editors group → AccessKey, with
 *      the one-time secret surviving a SECOND deploy (state persistence).
 *   2. S3 round-trip: the injected env values (endpoint, bucket, key id,
 *      secret) actually work against the real bucket — put/get/delete.
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { S3Client, S3Errors } from '@bradenmacdonald/s3-lite-client'
import type { GroupId } from '../../../../modules/resources/iam/v1/group.schema'
import { Nebius, test } from '../../../helpers/stack'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

/**
 * The tenant's default `editors` group (pre-created by Nebius). Discoverable
 * via `nebius iam group list --parent-id <tenant>` → name == "editors".
 * The binding's provisioning will look this up at deploy time; the test pins
 * the tenant's known id.
 */
const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m' as GroupId

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
      expect(String(sa.parentId)).toBe(String(process.env.NEBIUS_PROJECT_ID))

      // The grant path from the Nebius docs: SA into the default editors group.
      yield* stack.deploy(
        Nebius.iam.GroupMembership('BindTestMembership', {
          parentId: EDITORS_GROUP_ID,
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
  { timeout: 120_000 },
)

integrationTest(
  test.provider,
  'Nebius bindings: editors-group grant + S3 round-trip',
  (stack) =>
    Effect.gen(function* () {
      const sa = yield* stack.deploy(
        Nebius.iam.ServiceAccount('BindTripSA', {
          description: 'binding integration test',
        }),
      )
      yield* stack.deploy(
        Nebius.iam.GroupMembership('BindTripMembership', {
          parentId: EDITORS_GROUP_ID,
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

      // The exact env values the binding injects (D7) — prove they work.
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
      const missing = yield* attempt(() =>
        client.getObject('definitely-missing-key').then(
          (r) => ({ ok: true as const, response: r }),
          (e: unknown) => ({ ok: false as const, error: e }),
        ),
      )
      expect(missing.ok).toBe(false)
      if (missing.ok) throw new Error('unreachable')
      expect(missing.error).toBeInstanceOf(S3Errors.ServerError)
    }).pipe(safeDestroy(stack)),
  { timeout: 180_000 },
)
