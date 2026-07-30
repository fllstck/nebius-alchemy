import * as Alchemy from 'alchemy'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as IamGrpc from '../../../api-client/iam'
import * as QuotasGrpc from '../../../api-client/quotas'
import * as Validation from '../../validation.ts'
import * as QuotaAllowanceModule from './quota-allowance.ts'
import type * as ProjectSchema from '../../iam/v2/project.schema.ts'

// ── Quota ─────────────────────────────────────────────────────────────────

export const GetQuota = Alchemy.Action(
  'Nebius.quotas.actions.GetQuota',
  Effect.gen(function* () {
    const quotas = yield* QuotasGrpc.QuotasGrpcService
    const defaultProjectId = yield* Config.string('NEBIUS_PROJECT_ID')
    return ({ name, region, parentId }: { name: string; region: string; parentId?: ProjectSchema.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* quotas.quotaAllowance
          .getByName({ parentId: pid, name, region })
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
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
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* Config.string('NEBIUS_TENANT_ID')
    return ({ parentId }: { parentId?: ProjectSchema.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = parentId ? [parentId] : (yield* iam.project.list(tenantId)).map((p) => p.metadata!.id)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          quotas.quotaAllowance.list(pid).pipe(
            Effect.map((items) => items.map((raw) => QuotaAllowanceModule.toFriendlyAttributes(raw))),
            Effect.catch(() => Effect.succeed([] as readonly ReturnType<typeof QuotaAllowanceModule.toFriendlyAttributes>[])),
          ),
        )
        return results.flat()
      })
  }),
)
