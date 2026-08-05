import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(!process.env.SLOW_TESTS)(
  'Nebius.mysterybox.v1.Secret lifecycle',
  (stack) =>
    Effect.gen(function* () {
      const { secret } = yield* stack.deploy(
        Effect.gen(function* () {
          const secret = yield* Nebius.mysterybox.Secret('MBTest-Secret', {
            description: 'Alchemy integration test secret',
            payloads: [{ key: 'test-key', stringValue: 'test-value' }],
          })
          return { secret }
        }),
      )

      expect(secret.id).toBeDefined()
      expect(typeof secret.id).toBe('string')
      expect(secret.description).toBe('Alchemy integration test secret')
      expect(secret.state).toBe('ACTIVE')
    }).pipe(
      Effect.ensuring(stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )),
    ),
  { timeout: 120_000 },
)
