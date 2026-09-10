import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'

/**
 * Was `skipIf(true)` with the reason "requires paid tier — quota unavailable for
 * trial accounts", recorded only in the test NAME. Re-tried 2026-09-10 against the
 * live project: it passes (4 GiB source disk → snapshot), so that constraint no
 * longer applies. If it regresses with a quota error, record the reason as a
 * comment here — not just in the name.
 */
integrationTest(
  test.provider,
  'Nebius.compute.v1.DiskSnapshot lifecycle',
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
