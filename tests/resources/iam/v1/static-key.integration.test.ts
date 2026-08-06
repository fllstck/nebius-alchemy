import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'

integrationTest(
  test.provider,
  'Nebius.iam.v1.StaticKey lifecycle',
  (stack) =>
    Effect.gen(function* () {
      // Create SA first so its id is a concrete value
      const sa = yield* stack.deploy(
        Nebius.iam.ServiceAccount('SKTest-SA', {
          description: 'Alchemy StaticKey test SA',
        }),
      )

      const key = yield* stack.deploy(
        Nebius.iam.StaticKey('SKTest-Key', {
          serviceAccountId: sa.id,
          service: 'OBSERVABILITY',
        }),
      )

      expect(key.id).toBeDefined()
      expect(typeof key.id).toBe('string')
      expect(key.serviceAccountId).toBe(sa.id)
      expect(key.secretKey).toBeDefined()
      expect(key.secretKey.length).toBeGreaterThan(0)
      expect(key.accessKey).toBeDefined()
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 120_000 },
)
