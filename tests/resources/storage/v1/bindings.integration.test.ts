/**
 * M4 fix probe (scratch): which resource combination hangs in one deploy?
 * Variant A: SA + membership + key (all new). Variant B: + group.
 */
import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(
  test.provider,
  'HOSTID-A: SA + membership + key in one deploy',
  (stack) =>
    Effect.gen(function* () {
      console.log('[A] start')
      const { sa, membership, key } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('ASABindingSA', {
            description: 'host identity chain test',
          })
          const membership = yield* Nebius.iam.GroupMembership('AMembershipBindingMembership', {
            parentId: 'group-e00ee03sdm7ht85b9m' as never,
            memberId: sa.id,
          })
          const key = yield* Nebius.iam.AccessKey('AKeyBindingKey', {
            serviceAccountId: sa.id,
            secretDeliveryMode: 'INLINE',
          })
          return { sa, membership, key }
        }),
      )
      console.log(`[A] sa=${sa.id} mem=${membership.id} key=${key.id}`)
    }).pipe(safeDestroy(stack)),
  { timeout: 90_000 },
)
