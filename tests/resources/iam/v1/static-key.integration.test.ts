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
      // ONE deploy, with the service account declared alongside the key and referenced through its
      // in-effect instance — the shape that used to fail (`precreate` validated the raw, unresolved
      // `serviceAccountId`: `PropsValidationError: Expected string`). `StaticKey` issues in
      // `reconcile` now (TASKS.md §F), so this is also the regression pin.
      const { sa, key } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('SKTest-SA', {
            description: 'Alchemy StaticKey test SA',
          })
          const key = yield* Nebius.iam.StaticKey('SKTest-Key', {
            serviceAccountId: sa.id,
            service: 'OBSERVABILITY',
          })
          return { sa, key }
        }),
      )

      expect(key.id).toBeDefined()
      expect(typeof key.id).toBe('string')
      expect(key.serviceAccountId).toBe(sa.id)
      // The one-time token rides on the `Issue` response — captured into the attributes on create.
      expect(key.secretKey).toBeDefined()
      expect(key.secretKey.length).toBeGreaterThan(0)
      expect(key.accessKey).toBeDefined()
      console.log(`PROBE StaticKey id=${key.id} sa=${sa.id} token length=${key.secretKey.length}`)
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 180_000 },
)
