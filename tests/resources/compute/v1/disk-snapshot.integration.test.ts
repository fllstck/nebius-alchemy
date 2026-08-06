import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'

test.provider.skipIf(true)(
  'Nebius.compute.v1.DiskSnapshot lifecycle (requires paid tier — quota unavailable for trial accounts)',
  (stack) =>
  Effect.gen(function* () {
    // Create source disk first
    const disk = yield* stack.deploy(
      Nebius.compute.Disk('SnapshotSrc', {
        type: 'NETWORK_SSD',
        sizeGibibytes: 4,
      }),
    )

    const snap = yield* stack.deploy(
      Nebius.compute.DiskSnapshot('LifecycleTest', {
        sourceDiskId: disk.id,
        description: 'Alchemy integration test snapshot',
      }),
    )

    expect(snap.id).toBeDefined()
    expect(typeof snap.id).toBe('string')
    expect(snap.description).toBe('Alchemy integration test snapshot')
    expect(snap.sourceDiskId).toBe(disk.id)
    expect(snap.state).toBe('READY')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 300_000 },
)
