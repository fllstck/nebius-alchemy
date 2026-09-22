import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusPoolSchema from '../../../../schemas/nebius/vpc/v1/pool.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
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

/**
 * Compare CIDR blocks element by element, because the API materializes per-block defaults the props
 * may omit: a create with `cidrs: [{ cidr: '10.0.0.0/24' }]` comes back as
 * `[{ cidr: '10.0.0.0/24', state: 'AVAILABLE', maxMaskLength: '32' }]`.
 *
 * The previous whole-array `specDeepEqual` therefore compared the platform's `AVAILABLE`/32 against
 * the omitted props' `STATE_UNSPECIFIED`/0 and wrote an update on EVERY reconcile — probed live
 * 2026-09-22: `resourceVersion` climbed 2 → 3 → 4 across two reconciles that should have written
 * nothing, each logging `Updating Nebius.vpc.v1.Pool`.
 *
 * `cidr` is required and always compared; the two optional fields are compared **only when the
 * user pinned them** (the same news-side guard as `subnet.routeTableId`): omitting them means
 * "leave whatever the platform has", which is what the convergence contract requires.
 */
const cidrsDrifted = (
  current: ReadonlyArray<NebiusPoolSchema.PoolCidr>,
  desired: ReadonlyArray<NebiusPoolSchema.PoolCidr>,
  props: PoolSchema.PoolProps['cidrs'],
): boolean => {
  if (current.length !== desired.length) return true
  return current.some((live, index) => {
    const want = desired[index]
    if (want === undefined) return true
    if (live.cidr !== want.cidr) return true
    const prop = props[index]
    if (prop?.state !== undefined && live.state !== want.state) return true
    if (
      prop?.maxMaskLength !== undefined &&
      !ResourceUtils.specDeepEqual(live.maxMaskLength, want.maxMaskLength)
    )
      return true
    return false
  })
}

const specDrifted = (
  current: NebiusPoolSchema.PoolSpec,
  desired: NebiusPoolSchema.PoolSpec,
  props: PoolSchema.PoolProps,
): boolean =>
  current.sourcePoolId !== desired.sourcePoolId ||
  current.version !== desired.version ||
  current.visibility !== desired.visibility ||
  cidrsDrifted(current.cidrs, desired.cidrs, props.cidrs)

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusPoolProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusPool>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusPool>, never, any>)
  : AlchemyProvider.succeed(NebiusPool, {
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
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
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
    if (pool.spec && specDrifted(pool.spec, desired, news)) {
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
    validate: PoolSchema.validatePoolProps,
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

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* PoolSchema.validatePoolProps(news)
    return Factory.identityChangeRequiresReplace(news, olds)
  }),
})
