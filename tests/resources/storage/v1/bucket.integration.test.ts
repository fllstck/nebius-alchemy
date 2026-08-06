import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'
import * as StorageGrpc from '../../../../modules/api-client/storage.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!

/** Post-destroy leak check: no `nebius-storage-*` bucket may survive. */
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

integrationTest(test.provider, 'Nebius.storage.v1.Bucket lifecycle', (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Nebius.storage.Bucket('LifecycleTest', {
        versioningPolicy: 'DISABLED',
        defaultStorageClass: 'STANDARD',
        objectAuditLogging: 'NONE',
        forceStorageClass: false,
      }),
    )

    expect(created.id).toBeDefined()
    expect(typeof created.id).toBe('string')
    expect(created.name).toBeDefined()
    expect(created.state).toBe('ACTIVE')
    expect(created.versioningPolicy).toBe('DISABLED')

    // --- Update ---
    const updated = yield* stack.deploy(
      Nebius.storage.Bucket('LifecycleTest', {
        versioningPolicy: 'ENABLED',
        defaultStorageClass: 'STANDARD',
        objectAuditLogging: 'NONE',
        forceStorageClass: true,
      }),
    )

    expect(updated.id).toBe(created.id)
    expect(updated.versioningPolicy).toBe('ENABLED')
  }).pipe(
    safeDestroy(stack, verifyNoBucketLeaks),
  ),
  { timeout: 120_000 },
)
