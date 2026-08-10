import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusRouteSchema from '../../../../schemas/nebius/vpc/v1/route.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
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

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusRouteProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusRoute>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusRoute>, never, any>)
  : AlchemyProvider.succeed(NebiusRoute, {
  // Routes are children of a RouteTable — nuke deletes routes before their
  // route table.
  nuke: { dependsOn: ['Nebius.vpc.v1.RouteTable'] },

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

  // Routes are children of a RouteTable — enumerate every route table in the
  // tenant and list each table's routes. Without this, nuke can't delete routes
  // before their table (Nebius does not cascade-delete), so route-table deletes
  // would fail or orphan routes.
  list: Effect.fn('Nebius.vpc.v1.Route.list')(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* Config.string('NEBIUS_TENANT_ID')
    const projects = yield* iam.project.list(tenantId)
    const rows = yield* Effect.forEach(projects, (project) =>
      vpc.routeTable.list(project.metadata!.id).pipe(
        Effect.flatMap((tables) =>
          Effect.forEach(tables, (table) =>
            vpc.route.list(table.metadata!.id).pipe(
              Effect.map((routes) => routes.map((r) => toFriendlyAttributes(r))),
              Effect.catch(() => Effect.succeed([] as RouteSchema.RouteAttributes[])),
            ),
          ),
        ),
        Effect.map((nested) => nested.flat()),
        Effect.catch(() => Effect.succeed([] as RouteSchema.RouteAttributes[])),
      ),
    )
    return rows.flat()
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
