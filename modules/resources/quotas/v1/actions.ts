import * as Alchemy from 'alchemy'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as QuotasGrpc from '../../../api-client/quotas.ts'
import * as Validation from '../../validation.ts'
import * as QuotaAllowanceModule from './quota-allowance.ts'
import { bestEffortList, resolveParentIds } from '../../shared/fan-out.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'
import { getOrUndefined } from '../../shared/not-found.ts'

// ── Quota ─────────────────────────────────────────────────────────────────

export const GetQuota = Alchemy.Action(
  'Nebius.quotas.actions.GetQuota',
  Effect.gen(function* () {
    const quotas = yield* QuotasGrpc.QuotasGrpcService
    const defaultProjectId = yield* Config.String('NEBIUS_PROJECT_ID')
    return ({ name, region, parentId }: { name: string; region: string; parentId?: IamV2Ids.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* getOrUndefined(quotas.quotaAllowance.getByName({ parentId: pid, name, region }))
        if (!result) {
          return yield* Effect.fail(
            new Validation.ResourceNotFoundError({
              resourceType: 'quota',
              name,
              parent: `${pid}/${region}`,
              message: `No quota named "${name}" found in project ${pid}, region ${region}`,
            }),
          )
        }
        return QuotaAllowanceModule.toFriendlyAttributes(result)
      })
  }),
)

export const ListQuotas = Alchemy.Action(
  'Nebius.quotas.actions.ListQuotas',
  Effect.gen(function* () {
    const quotas = yield* QuotasGrpc.QuotasGrpcService
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = yield* resolveParentIds(parentId)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          bestEffortList(
            `quota allowances in project ${pid}`,
            quotas.quotaAllowance
              .list(pid)
              .pipe(Effect.map((items) => items.map((raw) => QuotaAllowanceModule.toFriendlyAttributes(raw)))),
          ),
        )
        return results.flat()
      })
  }),
)
