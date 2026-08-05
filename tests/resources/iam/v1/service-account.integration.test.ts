import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const { test } = Test.make({ providers: Nebius.providers() as any })

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
      Effect.ensuring(safeDestroy(stack)),
    ),
  { timeout: 120_000 },
)
