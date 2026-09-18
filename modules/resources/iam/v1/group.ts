import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusGroupSchema from '../../../../schemas/nebius/iam/v1/group.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as GroupSchema from './group.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusGroup = Alchemy.Resource<
  'Nebius.iam.v1.Group',
  GroupSchema.GroupProps,
  GroupSchema.GroupAttributes
>

export const NebiusGroup = Alchemy.Resource<NebiusGroup>('Nebius.iam.v1.Group')

// ----- HELPERS

export const toFriendlyAttributes = (raw: NebiusGroupSchema.Group): GroupSchema.GroupAttributes =>
  ResourceUtils.toFriendlyAttributes<GroupSchema.GroupAttributes>({
    rawResource: raw,
    resourceSchema: NebiusGroupSchema.Group,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusGroupProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusGroup>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusGroup>, never, any>)
  : AlchemyProvider.succeed(NebiusGroup, {
  reconcile: Effect.fn('Nebius.iam.v1.Group.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* GroupSchema.validateGroupProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    let group: NebiusGroupSchema.Group | undefined
    if (output?.id) {
      group = yield* iam.group
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!group) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.iam.v1.Group (${name})`)
      group = yield* iam.group.create({
        metadata: { parentId, name, labels },
        spec: NebiusGroupSchema.GroupSpec.fromPartial({}),
      })
    }

    // Group spec is empty — nothing to update

    return toFriendlyAttributes(group)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.Group',
    resourceLabel: 'Group',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.group.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v1.Group',
    validate: GroupSchema.validateGroupProps,
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.group.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.iam.v1.Group',
    service: IamGrpc.IamGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (project) => project.metadata!.id,
    listByParent: (svc, parentId) => svc.group.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.Group.diff')(function* ({ news, olds }) {
    news = news || ({} as GroupSchema.GroupProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* GroupSchema.validateGroupProps(news)
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
