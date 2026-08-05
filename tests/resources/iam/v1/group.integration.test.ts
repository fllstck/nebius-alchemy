import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(test.provider, 'Nebius.iam.v1.Group lifecycle', (stack) =>
  Effect.gen(function* () {
    const group = yield* stack.deploy(
      Nebius.iam.Group('LifecycleTest', {}),
    )

    expect(group.id).toBeDefined()
    expect(typeof group.id).toBe('string')
    expect(group.name).toBeDefined()
    expect(group.state).toBeDefined()
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
