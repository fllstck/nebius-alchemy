/**
 * M3 integration test — identity lifecycle (SA → editors-group membership →
 * access key) via the alchemy stack.
 *
 * PATTERN (important): the scratch stack re-plans the whole stack on every
 * `stack.deploy(...)` call and DELETES resources not present in the new
 * effect. So:
 *   1. Deploy the dependency (SA) in its own call so its id is concrete.
 *   2. Later deploys RE-DECLARE the full resource set (the SA becomes a
 *      noop — NOT deleted) and reference it with the IN-EFFECT resource
 *      instance (`.id`), so the dependency edge is declared and the destroy
 *      phase deletes children (key) before parents (SA).
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m'

integrationTest(
  test.provider,
  'Nebius.iam identity lifecycle (SA → editors membership → access key)',
  (stack) =>
    Effect.gen(function* () {
      // Stage 1: SA alone — its id becomes concrete state for later stages.
      const { sa } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('BindingSA', {
            description: 'bindings integration test SA',
          })
          return { sa }
        }),
      )
      expect(sa.id).toMatch(/^serviceaccount-/)
      console.log(`[BIND] SA id: ${sa.id}`)

      // Stage 2: re-declare the SA (noop — not deleted) and reference it via
      // the in-effect resource instance so the dependency edge is declared.
      const { membership, key } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('BindingSA', {
            description: 'bindings integration test SA',
          })
          const membership = yield* Nebius.iam.GroupMembership('BindingMembership', {
            parentId: EDITORS_GROUP_ID as never,
            memberId: sa.id,
          })
          const key = yield* Nebius.iam.AccessKey('BindingKey', {
            serviceAccountId: sa.id,
            secretDeliveryMode: 'INLINE',
          })
          return { membership, key }
        }),
      )

      expect(membership.id).toMatch(/^groupmembership-/)
      expect(key.id).toMatch(/^accesskey-/)
      expect(key.serviceAccountId).toBe(sa.id)
      expect(key.secretAccessKey.length).toBeGreaterThan(0)
      console.log(`[BIND] membership: ${membership.id}`)
      console.log(`[BIND] KEY: ${key.id} aws=${key.awsAccessKeyId}`)
    }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)
