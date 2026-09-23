import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'

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
const specDrifted = (
  current: NebiusSubnetSchema.SubnetSpec,
  desired: NebiusSubnetSchema.SubnetSpec,
  props: SubnetSchema.SubnetProps,
): boolean =>
  current.networkId !== desired.networkId ||
  // ⚠️ Live behaviour, probed 2026-09-22 (`tests/resources/vpc/v1/subnet.integration.test.ts`):
  // the API MATERIALIZES both pool structs into `spec` — `{ pools: [], useNetworkPools: true }`
  // ("use the network's pools") — when the props omit them, and echoes them back on every
  // update. `desired` never carries them, so comparing that echo unguarded wrote an update on
  // EVERY reconcile (observed live as `metadata.resourceVersion` = 2 after a single create:
  // create + a spurious update). Only compare a pool struct the user pinned, exactly as for
  // `routeTableId` below.
  (props.ipv4PrivatePools !== undefined &&
    !ResourceUtils.specDeepEqual(current.ipv4PrivatePools, desired.ipv4PrivatePools)) ||
  (props.ipv4PublicPools !== undefined &&
    !ResourceUtils.specDeepEqual(current.ipv4PublicPools, desired.ipv4PublicPools)) ||
  // `routeTableId`: only compare it when the user pinned it. When no route table is requested
  // the spec field stays empty (`""`) and the effective association is reported through
  // `status.routeTable.{id,default}` — so the field the guard actually protects is a PINNED
  // route table the user then drops from config: without the guard the live id is compared
  // against the omitted prop's `""` and the update drops the association back to the network
  // default on every reconcile.
  (props.routeTableId !== undefined && current.routeTableId !== desired.routeTableId)

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
  reconcile: Effect.fn('Nebius.vpc.v1.Subnet.reconcile')(function* ({ id, news, output, session, olds }) {
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
    //
    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed
    // in the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!subnet) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))

      yield* session.note(`Creating Nebius.vpc.v1.Subnet (${name})`)
      subnet = yield* vpcGrpcService.subnet.create({
        metadata: { parentId, name, labels },
        spec: NebiusSubnetSchema.SubnetSpec.fromJSON(news),
      })
    }

    // 3. Sync — update if spec drifted from desired
    // fromJSON handles the Schema.Struct readonly → mutable conversion for us.
    const desired = NebiusSubnetSchema.SubnetSpec.fromJSON(news)
    if ((subnet.spec && specDrifted(subnet.spec, desired, news)) || Factory.labelsDrifted(subnet.metadata?.labels, news.labels, olds?.labels)) {
      yield* session.note(`Updating Nebius.vpc.v1.Subnet (${subnet.metadata!.name})`)
      subnet = yield* vpcGrpcService.subnet.update({
        metadata: {
          id: subnet.metadata!.id,
          resourceVersion: subnet.metadata!.resourceVersion.toString(),
          labels,
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
    validate: SubnetSchema.validateSubnetProps,
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

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* SubnetSchema.validateSubnetProps(news)

    if (Factory.identityChangeRequiresReplace(news, olds)) return { action: 'replace' }
    // Spec-only change (parent and name unchanged): keep the identity — see
    // Factory.replaceKeepingName.
    if (news.networkId !== olds?.networkId) return Factory.replaceKeepingName(news)

    return undefined
  }),
})
