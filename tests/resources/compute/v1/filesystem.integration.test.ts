import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'

/**
 * Was `skipIf(true)` with the reason "requires paid tier — quota unavailable for
 * trial accounts", recorded only in the test NAME. Re-tried 2026-09-10 against the
 * live project: it passes (4 GiB NETWORK_SSD filesystem), so that constraint no
 * longer applies. If it regresses with a quota error, record the reason as a
 * comment here — not just in the name.
 */
integrationTest(
  test.provider,
  'Nebius.compute.v1.Filesystem lifecycle',
  (stack) =>
  Effect.gen(function* () {
    const fs = yield* stack.deploy(
      Nebius.compute.Filesystem('LifecycleTest', {
        type: 'NETWORK_SSD',
        sizeGibibytes: 4,
      }),
    )

    expect(fs.id).toBeDefined()
    expect(typeof fs.id).toBe('string')
    expect(fs.name).toBeDefined()
    expect(fs.type).toBe('NETWORK_SSD')
    expect(fs.state).toBe('READY')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 180_000 },
)
