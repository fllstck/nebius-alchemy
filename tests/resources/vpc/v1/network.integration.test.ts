import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(test.provider, 'Nebius.vpc.v1.Network lifecycle', (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Nebius.vpc.Network('LifecycleTest', {}),
    )

    expect(created.id).toBeDefined()
    expect(typeof created.id).toBe('string')
    expect(created.name).toBeDefined()
    expect(created.state).toBe('READY')
    expect(created.defaultRouteTableId).toBeDefined()
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
