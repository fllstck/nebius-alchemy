import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusPoolSchema from '../../../../schemas/nebius/vpc/v1/pool'
import * as IamGrpc from '../../../api-client/iam'
import * as VpcGrpc from '../../../api-client/vpc'
import * as ResourceUtils from '../../utilities.ts'

import * as PoolSchema from './pool.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusPool = Alchemy.Resource<'Nebius.vpc.v1.Pool', PoolSchema.PoolProps, PoolSchema.PoolAttributes>

export const NebiusPool = Alchemy.Resource<NebiusPool>('Nebius.vpc.v1.Pool')

// ----- HELPERS

export const toFriendlyAttributes = (raw: NebiusPoolSchema.Pool): PoolSchema.PoolAttributes =>
  ResourceUtils.toFriendlyAttributes<PoolSchema.PoolAttributes>({
    rawResource: raw,
    resourceSchema: NebiusPoolSchema.Pool,
  })

const specDrifted = (current: NebiusPoolSchema.PoolSpec, desired: NebiusPoolSchema.PoolSpec): boolean =>
  current.sourcePoolId !== desired.sourcePoolId ||
  current.version !== desired.version ||
  current.visibility !== desired.visibility ||
  !AlchemyDiff.deepEqual(current.cidrs, desired.cidrs)

// ----- PROVIDER

export const NebiusPoolProvider = AlchemyProvider.succeed(NebiusPool, {
  reconcile: Effect.fn('Nebius.vpc.v1.Pool.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* PoolSchema.validatePoolProps(news)

    const vpcGrpcService = yield* VpcGrpc.VpcGrpcService

    let pool: NebiusPoolSchema.Pool | undefined
    if (output?.id) {
      pool = yield* vpcGrpcService.pool
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!pool) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.vpc.v1.Pool (${name})`)
      pool = yield* vpcGrpcService.pool.create({
        metadata: { parentId, name, labels },
        // fromJSON required: PoolSpec has enums (version, visibility, cidrs[].state)
        spec: NebiusPoolSchema.PoolSpec.fromJSON(news),
      })
    }

    const desired = NebiusPoolSchema.PoolSpec.fromJSON(news)
    if (pool.spec && specDrifted(pool.spec, desired)) {
      yield* session.note(`Updating Nebius.vpc.v1.Pool (${pool.metadata!.name})`)
      pool = yield* vpcGrpcService.pool.update({
        metadata: { id: pool.metadata!.id, resourceVersion: pool.metadata!.resourceVersion.toString() },
        spec: desired,
      })
    }

    return toFriendlyAttributes(pool)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.vpc.v1.Pool',
    resourceLabel: 'Pool',
    service: VpcGrpc.VpcGrpcService,
    deleteById: (svc, id) => svc.pool.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.vpc.v1.Pool',
    service: VpcGrpc.VpcGrpcService,
    getById: (svc, id) => svc.pool.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.vpc.v1.Pool',
    service: VpcGrpc.VpcGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.pool.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.vpc.v1.Pool.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
