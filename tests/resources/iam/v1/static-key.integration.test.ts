import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'

const { test } = Test.make({ providers: Nebius.providers() as any })

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
      Effect.ensuring(
        Effect.gen(function* () {
          yield* stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )
        }),
      ),
    ),
  { timeout: 120_000 },
)
