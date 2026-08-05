import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(!process.env.SLOW_TESTS)(
  'Nebius.iam.v1.ServiceAccount lifecycle',
  (stack) =>
    Effect.gen(function* () {
      const { sa } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('SATest-SA', {
            description: 'Alchemy integration test SA',
          })
          return { sa }
        }),
      )

      expect(sa.id).toBeDefined()
      expect(typeof sa.id).toBe('string')
      expect(sa.active).toBe(true)
    }).pipe(
      Effect.ensuring(stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )),
    ),
  { timeout: 120_000 },
)
