import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusNetworkSchema from '../../../../schemas/nebius/vpc/v1/network.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as NetworkSchema from './network.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusNetwork = Alchemy.Resource<
  'Nebius.vpc.v1.Network',
  NetworkSchema.NetworkProps,
  NetworkSchema.NetworkAttributes
>

export const NebiusNetwork = Alchemy.Resource<NebiusNetwork>('Nebius.vpc.v1.Network')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusNetworkSchema.Network} (metadata + spec +
 * status) into {@link NetworkSchema.NetworkAttributes}.
 */
export const toFriendlyAttributes = (rawNetwork: NebiusNetworkSchema.Network): NetworkSchema.NetworkAttributes =>
  ResourceUtils.toFriendlyAttributes<NetworkSchema.NetworkAttributes>({
    rawResource: rawNetwork,
    resourceSchema: NebiusNetworkSchema.Network,
  })

// ----- PROVIDER

export const NebiusNetworkProvider = AlchemyProvider.succeed(NebiusNetwork, {
  // Observe → Ensure → Sync → Return
  reconcile: Effect.fn('Nebius.vpc.v1.Network.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}

    // Validate user input at runtime
    news = yield* NetworkSchema.validateNetworkProps(news)

    const vpcGrpcService = yield* VpcGrpc.VpcGrpcService

    // 1. Observe — fetch live state if we have a cached physical ID
    let network: NebiusNetworkSchema.Network | undefined
    if (output?.id) {
      network = yield* vpcGrpcService.network
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    if (!network) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.vpc.v1.Network (${name})`)
      network = yield* vpcGrpcService.network.create({
        metadata: { parentId, name, labels },
        spec: NebiusNetworkSchema.NetworkSpec.fromJSON(news),
      })
    }

    // 3. Sync — update if spec drifted from desired
    // fromJSON handles the Schema.Struct readonly → mutable conversion for us.
    const desired = NebiusNetworkSchema.NetworkSpec.fromJSON(news)
    if (
      network.spec &&
      (!AlchemyDiff.deepEqual(network.spec.ipv4PrivatePools, desired.ipv4PrivatePools) ||
        !AlchemyDiff.deepEqual(network.spec.ipv4PublicPools, desired.ipv4PublicPools))
    ) {
      yield* session.note(`Updating Nebius.vpc.v1.Network (${network.metadata!.name})`)
      network = yield* vpcGrpcService.network.update({
        metadata: {
          id: network.metadata!.id,
          resourceVersion: network.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    // 4. Return — fresh Attributes
    return toFriendlyAttributes(network)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.vpc.v1.Network',
    resourceLabel: 'Network',
    service: VpcGrpc.VpcGrpcService,
    deleteById: (svc, id) => svc.network.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.vpc.v1.Network',
    service: VpcGrpc.VpcGrpcService,
    getById: (svc, id) => svc.network.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.vpc.v1.Network',
    service: VpcGrpc.VpcGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.network.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.vpc.v1.Network.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
