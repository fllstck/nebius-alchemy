import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(
  test.provider,
  'Nebius.iam.v2.AccessKey lifecycle',
  (stack) =>
    Effect.gen(function* () {
      // Stage 1: SA alone — its id becomes concrete state for later stages.
      // (The scratch stack re-plans on every deploy and DELETES resources
      // absent from the new effect, so later deploys must re-declare it.)
      const { sa } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('AKTest-SA', {
            description: 'Alchemy AccessKey v2 test SA',
          })
          return { sa }
        }),
      )

      // Stage 2: re-declare the SA (noop) + the access key, referencing the
      // SA via the in-effect resource instance (dependency edge + ref).
      const { key } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('AKTest-SA', {
            description: 'Alchemy AccessKey v2 test SA',
          })
          const key = yield* Nebius.iam.AccessKey('AKTest-Key', {
            serviceAccountId: sa.id,
            description: 'Alchemy test access key (v2)',
          })
          return { key }
        }),
      )

      expect(key.id).toBeDefined()
      expect(typeof key.id).toBe('string')
      expect(key.serviceAccountId).toBe(sa.id)
      expect(key.awsAccessKeyId).toBeDefined()
      expect(key.awsAccessKeyId.length).toBeGreaterThan(0)
      expect(key.secretAccessKey).toBeDefined()
      expect(key.secretAccessKey.length).toBeGreaterThan(0)
      expect(key.secretDeliveryMode).toBe('INLINE')
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 120_000 },
)
