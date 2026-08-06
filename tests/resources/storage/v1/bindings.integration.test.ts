/**
 * M3 integration tests for the storage bindings.
 *
 * 1. Identity lifecycle: SA → default editors-group membership → v2 access
 *    key with INLINE secret (create + destroy).
 * 2. S3 round-trip: the full binding chain — bucket + SA → editors grant →
 *    access key → s3-lite-client (the same client the Worker binding uses) →
 *    PutObject/GetObject round-trip against real Nebius S3.
 *
 * PATTERN (see agent-patterns/alchemy-test-patterns.md): the scratch stack
 * re-plans on every deploy and DELETES resources absent from the new effect.
 * Stage 1 deploys dependencies (bucket + SA) alone; stage 2 re-declares them
 * (noop) plus the dependent resources, referencing the SA via the in-effect
 * resource instance.
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { Nebius, test } from '../../../helpers/stack'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m'
const REGION = process.env.NEBIUS_REGION ?? 'eu-north1'

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
    }).pipe(safeDestroy(stack)),
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

      // PutObject → GetObject round-trip.
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

      // Clean the object so the bucket can be destroyed.
      yield* Effect.tryPromise({
        try: () => client.deleteObject(OBJECT_KEY),
        catch: (e) => Effect.fail(new Error(`deleteObject failed: ${String(e)}`)),
      })
      console.log('[RT] cleanup ok')
    }).pipe(safeDestroy(stack)),
  { timeout: 180_000 },
)
