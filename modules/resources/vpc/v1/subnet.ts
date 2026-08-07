import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusSubnetSchema from '../../../../schemas/nebius/vpc/v1/subnet.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as SubnetSchema from './subnet.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusSubnet = Alchemy.Resource<
  'Nebius.vpc.v1.Subnet',
  SubnetSchema.SubnetProps,
  SubnetSchema.SubnetAttributes
>

export const NebiusSubnet = Alchemy.Resource<NebiusSubnet>('Nebius.vpc.v1.Subnet')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusSubnetSchema.Subnet} (metadata + spec +
 * status) into {@link SubnetSchema.SubnetAttributes}.
 */
export const toFriendlyAttributes = (rawSubnet: NebiusSubnetSchema.Subnet): SubnetSchema.SubnetAttributes =>
  ResourceUtils.toFriendlyAttributes<SubnetSchema.SubnetAttributes>({
    rawResource: rawSubnet,
    resourceSchema: NebiusSubnetSchema.Subnet,
  })

/** Compare spec fields between desired (fromPartial) and current (from API). */
const specDrifted = (current: NebiusSubnetSchema.SubnetSpec, desired: NebiusSubnetSchema.SubnetSpec): boolean =>
  current.networkId !== desired.networkId ||
  !AlchemyDiff.deepEqual(current.ipv4PrivatePools, desired.ipv4PrivatePools) ||
  !AlchemyDiff.deepEqual(current.ipv4PublicPools, desired.ipv4PublicPools) ||
  current.routeTableId !== desired.routeTableId

// ----- PROVIDER

export const NebiusSubnetProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusSubnet>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusSubnet>, never, any>)
  : AlchemyProvider.succeed(NebiusSubnet, {
  // Observe → Ensure → Sync → Return
  reconcile: Effect.fn('Nebius.vpc.v1.Subnet.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}

    // Validate user input at runtime
    news = yield* SubnetSchema.validateSubnetProps(news)

    const vpcGrpcService = yield* VpcGrpc.VpcGrpcService

    // 1. Observe — fetch live state if we have a cached physical ID
    let subnet: NebiusSubnetSchema.Subnet | undefined
    if (output?.id) {
      subnet = yield* vpcGrpcService.subnet
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    if (!subnet) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.vpc.v1.Subnet (${name})`)
      subnet = yield* vpcGrpcService.subnet.create({
        metadata: { parentId, name, labels },
        spec: NebiusSubnetSchema.SubnetSpec.fromJSON(news),
      })
    }

    // 3. Sync — update if spec drifted from desired
    // fromJSON handles the Schema.Struct readonly → mutable conversion for us.
    const desired = NebiusSubnetSchema.SubnetSpec.fromJSON(news)
    if (subnet.spec && specDrifted(subnet.spec, desired)) {
      yield* session.note(`Updating Nebius.vpc.v1.Subnet (${subnet.metadata!.name})`)
      subnet = yield* vpcGrpcService.subnet.update({
        metadata: {
          id: subnet.metadata!.id,
          resourceVersion: subnet.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    // 4. Return — fresh Attributes
    return toFriendlyAttributes(subnet)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.vpc.v1.Subnet',
    resourceLabel: 'Subnet',
    service: VpcGrpc.VpcGrpcService,
    deleteById: (svc, id) => svc.subnet.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.vpc.v1.Subnet',
    service: VpcGrpc.VpcGrpcService,
    getById: (svc, id) => svc.subnet.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.vpc.v1.Subnet',
    service: VpcGrpc.VpcGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.subnet.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.vpc.v1.Subnet.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    if (news.name !== olds?.name) return { action: 'replace' }
    if (news.networkId !== olds?.networkId) return { action: 'replace' }

    return undefined
  }),
})
