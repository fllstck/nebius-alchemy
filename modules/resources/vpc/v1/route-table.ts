import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusRouteTableSchema from '../../../../schemas/nebius/vpc/v1/route_table.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as RouteTableSchema from './route-table.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusRouteTable = Alchemy.Resource<
  'Nebius.vpc.v1.RouteTable',
  RouteTableSchema.RouteTableProps,
  RouteTableSchema.RouteTableAttributes
>

export const NebiusRouteTable = Alchemy.Resource<NebiusRouteTable>('Nebius.vpc.v1.RouteTable')

// ----- HELPERS

export const toFriendlyAttributes = (raw: NebiusRouteTableSchema.RouteTable): RouteTableSchema.RouteTableAttributes =>
  ResourceUtils.toFriendlyAttributes<RouteTableSchema.RouteTableAttributes>({
    rawResource: raw,
    resourceSchema: NebiusRouteTableSchema.RouteTable,
  })

// ----- PROVIDER

export const NebiusRouteTableProvider = AlchemyProvider.succeed(NebiusRouteTable, {
  reconcile: Effect.fn('Nebius.vpc.v1.RouteTable.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* RouteTableSchema.validateRouteTableProps(news)

    const vpcGrpcService = yield* VpcGrpc.VpcGrpcService

    // 1. Observe
    let rt: NebiusRouteTableSchema.RouteTable | undefined
    if (output?.id) {
      rt = yield* vpcGrpcService.routeTable
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure
    if (!rt) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.vpc.v1.RouteTable (${name})`)
      rt = yield* vpcGrpcService.routeTable.create({
        metadata: { parentId, name, labels },
        spec: NebiusRouteTableSchema.RouteTableSpec.fromJSON(news),
      })
    }

    // 3. Sync
    const desired = NebiusRouteTableSchema.RouteTableSpec.fromJSON(news)
    if (rt.spec && rt.spec.networkId !== desired.networkId) {
      yield* session.note(`Updating Nebius.vpc.v1.RouteTable (${rt.metadata!.name})`)
      rt = yield* vpcGrpcService.routeTable.update({
        metadata: { id: rt.metadata!.id, resourceVersion: rt.metadata!.resourceVersion.toString() },
        spec: desired,
      })
    }

    return toFriendlyAttributes(rt)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.vpc.v1.RouteTable',
    resourceLabel: 'RouteTable',
    service: VpcGrpc.VpcGrpcService,
    deleteById: (svc, id) => svc.routeTable.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.vpc.v1.RouteTable',
    service: VpcGrpc.VpcGrpcService,
    getById: (svc, id) => svc.routeTable.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.vpc.v1.RouteTable',
    service: VpcGrpc.VpcGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.routeTable.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.vpc.v1.RouteTable.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined
    if (news.name !== olds?.name) return { action: 'replace' }
    if (news.networkId !== olds?.networkId) return { action: 'replace' }
    return undefined
  }),
})
