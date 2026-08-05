import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const { test } = Test.make({ providers: Nebius.providers() as any })

integrationTest(
  test.provider,
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
      safeDestroy(stack),
    ),
  { timeout: 120_000 },
)
