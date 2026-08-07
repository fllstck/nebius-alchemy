import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusAllocationSchema from '../../../../schemas/nebius/vpc/v1/allocation.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as AllocationSchema from './allocation.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusAllocation = Alchemy.Resource<
  'Nebius.vpc.v1.Allocation',
  AllocationSchema.AllocationProps,
  AllocationSchema.AllocationAttributes
>

export const NebiusAllocation = Alchemy.Resource<NebiusAllocation>('Nebius.vpc.v1.Allocation')

// ----- HELPERS

const toFriendlyAttributes = (raw: NebiusAllocationSchema.Allocation): AllocationSchema.AllocationAttributes =>
  ResourceUtils.toFriendlyAttributes<AllocationSchema.AllocationAttributes>({
    rawResource: raw,
    resourceSchema: NebiusAllocationSchema.Allocation,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusAllocationProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusAllocation>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusAllocation>, never, any>)
  : AlchemyProvider.succeed(NebiusAllocation, {
  reconcile: Effect.fn('Nebius.vpc.v1.Allocation.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* AllocationSchema.validateAllocationProps(news)

    const vpcGrpcService = yield* VpcGrpc.VpcGrpcService

    let allocation: NebiusAllocationSchema.Allocation | undefined
    if (output?.id) {
      allocation = yield* vpcGrpcService.allocation
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!allocation) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.vpc.v1.Allocation (${name})`)
      allocation = yield* vpcGrpcService.allocation.create({
        metadata: { parentId, name, labels },
        spec: NebiusAllocationSchema.AllocationSpec.fromJSON(news),
      })
    }

    const desired = NebiusAllocationSchema.AllocationSpec.fromJSON(news)
    if (
      allocation.spec &&
      !AlchemyDiff.deepEqual(allocation.spec, desired)
    ) {
      yield* session.note(`Updating Nebius.vpc.v1.Allocation (${allocation.metadata!.name})`)
      allocation = yield* vpcGrpcService.allocation.update({
        metadata: { id: allocation.metadata!.id, resourceVersion: allocation.metadata!.resourceVersion.toString() },
        spec: desired,
      })
    }

    return toFriendlyAttributes(allocation)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.vpc.v1.Allocation',
    resourceLabel: 'Allocation',
    service: VpcGrpc.VpcGrpcService,
    deleteById: (svc, id) => svc.allocation.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.vpc.v1.Allocation',
    service: VpcGrpc.VpcGrpcService,
    getById: (svc, id) => svc.allocation.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.vpc.v1.Allocation',
    service: VpcGrpc.VpcGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.allocation.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.vpc.v1.Allocation.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
