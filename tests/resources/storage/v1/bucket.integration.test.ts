import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

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
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
