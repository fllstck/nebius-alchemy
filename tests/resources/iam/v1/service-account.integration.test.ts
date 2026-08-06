import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'

integrationTest(
  test.provider,
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
      safeDestroy(stack),
    ),
  { timeout: 120_000 },
)
