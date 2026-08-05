/**
 * M3 bisect probe (scratch) — reproduce the stack access-key failure with a
 * wire dump, to compare against the standalone probe. Deleted after the bisect.
 */
import * as Effect from 'effect/Effect'
import * as ChildProcess from 'node:child_process'
import { Nebius, test } from '../../../helpers/stack'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m'

integrationTest(
  test.provider,
  'BISECT: stack access-key with CLI SA',
  (stack) =>
    Effect.gen(function* () {
      const out = yield* Effect.sync(() =>
        String(
          ChildProcess.execSync(
            `nebius iam service-account create --parent-id ${process.env.NEBIUS_PROJECT_ID} ` +
              `--name cli-bisect-${Date.now().toString(36)}`,
          ),
        ),
      )
      const saId = out.match(/id: (serviceaccount-[a-z0-9]+)/)?.[1]
      if (!saId) return yield* Effect.die('no SA id')

      yield* stack.deploy(
        Nebius.iam.GroupMembership('BisectMembership', {
          parentId: EDITORS_GROUP_ID as never,
          memberId: saId,
        }),
      )

      yield* stack.deploy(
        Nebius.iam.AccessKey('BisectKey', {
          serviceAccountId: saId as never,
          secretDeliveryMode: 'INLINE',
        }),
      )
      console.log('BISECT KEY OK')

      yield* Effect.sync(() => {
        ChildProcess.execSync(`nebius iam service-account delete --id ${saId}`)
      })
    }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)
