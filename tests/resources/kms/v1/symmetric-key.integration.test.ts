import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(!process.env.SLOW_TESTS)(
  'Nebius.kms.v1.SymmetricKey lifecycle',
  (stack) =>
    Effect.gen(function* () {
      const { key } = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* Nebius.kms.SymmetricKey('KMSTest-Key', {
            description: 'Alchemy integration test KMS key',
            algorithm: 'AES_256',
          })
          return { key }
        }),
      )

      expect(key.id).toBeDefined()
      expect(typeof key.id).toBe('string')
      expect(key.description).toBe('Alchemy integration test KMS key')
      expect(key.algorithm).toBe('AES_256')
    }).pipe(
      Effect.ensuring(stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )),
    ),
  { timeout: 120_000 },
)
