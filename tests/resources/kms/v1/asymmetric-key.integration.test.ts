import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(
  test.provider,
  'Nebius.kms.v1.AsymmetricKey lifecycle',
  (stack) =>
    Effect.gen(function* () {
      const { key } = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* Nebius.kms.AsymmetricKey('AKTest-Key', {
            description: 'Alchemy integration test asymmetric key',
            algorithm: 'ECDSA_NIST_P256_SHA_256',
          })
          return { key }
        }),
      )

      expect(key.id).toBeDefined()
      expect(typeof key.id).toBe('string')
      expect(key.algorithm).toBe('ECDSA_NIST_P256_SHA_256')
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 120_000 },
)
