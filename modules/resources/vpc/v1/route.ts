import * as Effect from 'effect/Effect'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusRouteSchema from '../../../../schemas/nebius/vpc/v1/route.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as RouteSchema from './route.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusRoute = Alchemy.Resource<
  'Nebius.vpc.v1.Route',
  RouteSchema.RouteProps,
  RouteSchema.RouteAttributes
>

export const NebiusRoute = Alchemy.Resource<NebiusRoute>('Nebius.vpc.v1.Route')

// ----- HELPERS

const toFriendlyAttributes = (raw: NebiusRouteSchema.Route): RouteSchema.RouteAttributes =>
  ResourceUtils.toFriendlyAttributes<RouteSchema.RouteAttributes>({
    rawResource: raw,
    resourceSchema: NebiusRouteSchema.Route,
  })

const specDrifted = (current: NebiusRouteSchema.RouteSpec, desired: NebiusRouteSchema.RouteSpec): boolean =>
  !AlchemyDiff.deepEqual(current.destination, desired.destination) ||
  !AlchemyDiff.deepEqual(current.nextHop, desired.nextHop) ||
  current.description !== desired.description

// ----- PROVIDER

export const NebiusRouteProvider = AlchemyProvider.succeed(NebiusRoute, {
  reconcile: Effect.fn('Nebius.vpc.v1.Route.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* RouteSchema.validateRouteProps(news)

    const vpcGrpcService = yield* VpcGrpc.VpcGrpcService

    // 1. Observe
    let route: NebiusRouteSchema.Route | undefined
    if (output?.id) {
      route = yield* vpcGrpcService.route
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — parent is the RouteTable, not the Project
    if (!route) {
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.vpc.v1.Route (${name})`)
      route = yield* vpcGrpcService.route.create({
        metadata: { parentId: news.parentId, name, labels },
        spec: NebiusRouteSchema.RouteSpec.fromJSON(news),
      })
    }

    // 3. Sync
    const desired = NebiusRouteSchema.RouteSpec.fromJSON(news)
    if (route.spec && specDrifted(route.spec, desired)) {
      yield* session.note(`Updating Nebius.vpc.v1.Route (${route.metadata!.name})`)
      route = yield* vpcGrpcService.route.update({
        metadata: { id: route.metadata!.id, resourceVersion: route.metadata!.resourceVersion.toString() },
        spec: desired,
      })
    }

    return toFriendlyAttributes(route)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.vpc.v1.Route',
    resourceLabel: 'Route',
    service: VpcGrpc.VpcGrpcService,
    deleteById: (svc, id) => svc.route.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.vpc.v1.Route',
    service: VpcGrpc.VpcGrpcService,
    getById: (svc, id) => svc.route.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // No project-scoped list — routes are children of a specific RouteTable.
  list: Effect.fn('Nebius.vpc.v1.Route.list')(function* () {
    yield* Effect.void
    return []
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.vpc.v1.Route.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined
    if (news.name !== olds?.name) return { action: 'replace' }
    if (news.parentId !== olds?.parentId) return { action: 'replace' }
    // defaultEgressGateway is sticky-true: once enabled, it cannot be disabled
    if (
      olds?.nextHop?.defaultEgressGateway === true &&
      news.nextHop?.defaultEgressGateway === false
    )
      return { action: 'replace' }
    return undefined
  }),
})
