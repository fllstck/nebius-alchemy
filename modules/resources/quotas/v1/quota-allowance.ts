import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'

import * as NebiusQuotaAllowanceSchema from '../../../../schemas/nebius/quotas/v1/quota_allowance'
import * as IamGrpc from '../../../api-client/iam'
import * as QuotasGrpc from '../../../api-client/quotas'
import * as ResourceUtils from '../../utilities.ts'

import * as QuotaAllowanceSchema from './quota-allowance.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusQuotaAllowance = Alchemy.Resource<
  'Nebius.quotas.v1.QuotaAllowance',
  QuotaAllowanceSchema.QuotaAllowanceProps,
  QuotaAllowanceSchema.QuotaAllowanceAttributes
>

export const NebiusQuotaAllowance = Alchemy.Resource<NebiusQuotaAllowance>('Nebius.quotas.v1.QuotaAllowance')

// ----- HELPERS

export const toFriendlyAttributes = (
  raw: NebiusQuotaAllowanceSchema.QuotaAllowance,
): QuotaAllowanceSchema.QuotaAllowanceAttributes =>
  ResourceUtils.toFriendlyAttributes<QuotaAllowanceSchema.QuotaAllowanceAttributes>({
    rawResource: raw,
    resourceSchema: NebiusQuotaAllowanceSchema.QuotaAllowance,
  })

// ----- PROVIDER

export const NebiusQuotaAllowanceProvider = AlchemyProvider.succeed(NebiusQuotaAllowance, {
  reconcile: Effect.fn('Nebius.quotas.v1.QuotaAllowance.reconcile')(function* ({ news, output, session }) {
    news = yield* QuotaAllowanceSchema.validateQuotaAllowanceProps(news)

    const grpcService = yield* QuotasGrpc.QuotasGrpcService
    const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))

    // 1. Observe — identity is (parentId, name, region), not id
    let qa: NebiusQuotaAllowanceSchema.QuotaAllowance | undefined
    if (output?.id) {
      qa = yield* grpcService.quotaAllowance
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }
    if (!qa) {
      qa = yield* grpcService.quotaAllowance
        .getByName({ parentId, name: news.name, region: news.region })
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing
    if (!qa) {
      yield* session.note(`Creating Nebius.quotas.v1.QuotaAllowance (${news.name})`)
      qa = yield* grpcService.quotaAllowance.create({
        metadata: { parentId, name: news.name },
        spec: NebiusQuotaAllowanceSchema.QuotaAllowanceSpec.fromPartial({
          region: news.region,
          ...(news.limit ? { limit: news.limit } : {}),
        }),
      })
    }

    // 3. Sync — update if limit changed
    const desired = NebiusQuotaAllowanceSchema.QuotaAllowanceSpec.fromPartial({
      region: news.region,
      ...(news.limit ? { limit: news.limit } : {}),
    })
    if (qa.spec && !AlchemyDiff.deepEqual(qa.spec, desired)) {
      yield* session.note(`Updating Nebius.quotas.v1.QuotaAllowance (${qa.metadata!.name})`)
      qa = yield* grpcService.quotaAllowance.update({
        metadata: {
          id: qa.metadata!.id,
          resourceVersion: qa.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(qa)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.quotas.v1.QuotaAllowance',
    resourceLabel: 'QuotaAllowance',
    service: QuotasGrpc.QuotasGrpcService,
    deleteById: (svc, id) => svc.quotaAllowance.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.quotas.v1.QuotaAllowance',
    service: QuotasGrpc.QuotasGrpcService,
    getById: (svc, id) => svc.quotaAllowance.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.quotas.v1.QuotaAllowance',
    service: QuotasGrpc.QuotasGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.quotaAllowance.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.quotas.v1.QuotaAllowance.diff')(function* ({ news, olds }) {
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Identity is (name, region) — any change requires replace
    if (news.name !== olds?.name) return { action: 'replace' }
    if (news.region !== olds?.region) return { action: 'replace' }

    return undefined
  }),
})
