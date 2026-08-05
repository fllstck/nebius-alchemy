import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const { test } = Test.make({ providers: Nebius.providers() as any })

integrationTest(
  test.provider,
  'Nebius.iam.v2.AccessKey lifecycle',
  (stack) =>
    Effect.gen(function* () {
      // Create SA first so its id is a concrete value
      const sa = yield* stack.deploy(
        Nebius.iam.ServiceAccount('AKTest-SA', {
          description: 'Alchemy AccessKey v2 test SA',
        }),
      )

      const key = yield* stack.deploy(
        Nebius.iam.AccessKey('AKTest-Key', {
          serviceAccountId: sa.id,
          description: 'Alchemy test access key (v2)',
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
