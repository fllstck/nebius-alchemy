import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'

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
            // Task 7b field: the `...Seconds` prop is reshaped into a protobuf
            // Duration by the provider — this deploy is what proves the API
            // accepts that payload (30 days, inside the 1 day … 10 year range).
            rotationPeriodSeconds: 2_592_000,
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
