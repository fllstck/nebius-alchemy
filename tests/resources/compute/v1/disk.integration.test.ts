import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(test.provider, 'Nebius.compute.v1.Disk lifecycle', (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Nebius.compute.Disk('LifecycleTest', {
        type: 'NETWORK_SSD',
        sizeGibibytes: 4,
      }),
    )

    expect(created.id).toBeDefined()
    expect(typeof created.id).toBe('string')
    expect(created.name).toBeDefined()
    expect(created.type).toBe('NETWORK_SSD')
    expect(created.state).toBe('READY')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
