import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup'

test.provider.skipIf(true)(
  'Nebius.compute.v1.Filesystem lifecycle (requires paid tier — quota unavailable for trial accounts)',
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
