import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(test.provider, 'Nebius.iam.v1.Invitation lifecycle', (stack) =>
  Effect.gen(function* () {
    const inv = yield* stack.deploy(
      Nebius.iam.Invitation('LifecycleTest', {
        email: 'test@example.com',
        description: 'Alchemy integration test invitation',
        noSend: true,
      }),
    )

    expect(inv.id).toBeDefined()
    expect(typeof inv.id).toBe('string')
    expect(inv.description).toBe('Alchemy integration test invitation')
    expect(inv.email).toBe('test@example.com')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
