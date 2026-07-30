import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider('Nebius.iam.v1.Invitation lifecycle', (stack) =>
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
    Effect.ensuring(stack.destroy().pipe(Effect.ignore)),
  ),
  { timeout: 120_000 },
)
