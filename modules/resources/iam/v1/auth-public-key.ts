import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusAuthPublicKeySchema from '../../../../schemas/nebius/iam/v1/auth_public_key.ts'
import * as NebiusAccessSchema from '../../../../schemas/nebius/iam/v1/access.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as AuthPublicKeySchema from './auth-public-key.schema.ts'
import * as ServiceAccountSchema from './service-account.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusAuthPublicKey = Alchemy.Resource<
  'Nebius.iam.v1.AuthPublicKey',
  AuthPublicKeySchema.AuthPublicKeyProps,
  AuthPublicKeySchema.AuthPublicKeyAttributes
>

export const NebiusAuthPublicKey = Alchemy.Resource<NebiusAuthPublicKey>('Nebius.iam.v1.AuthPublicKey')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusAuthPublicKeySchema.AuthPublicKey,
): AuthPublicKeySchema.AuthPublicKeyAttributes => {
  const base = ResourceUtils.toFriendlyAttributes<AuthPublicKeySchema.AuthPublicKeyAttributes>({
    rawResource: raw,
    resourceSchema: NebiusAuthPublicKeySchema.AuthPublicKey,
  })
  const accountId = (raw.spec?.account?.serviceAccount?.id || '') as unknown as ServiceAccountSchema.ServiceAccountId
  return { ...base, accountId }
}

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusAuthPublicKeyProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusAuthPublicKey>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusAuthPublicKey>, never, any>)
  : AlchemyProvider.succeed(NebiusAuthPublicKey, {
  // The authorized key is a sub-resource of a ServiceAccount — nuke deletes
  // keys before their SA (Nebius does not cascade-delete associated resources).
  nuke: { dependsOn: ['Nebius.iam.v1.ServiceAccount'] },

  reconcile: Effect.fn('Nebius.iam.v1.AuthPublicKey.reconcile')(function* ({ id, news, output, session }) {
    news = yield* AuthPublicKeySchema.validateAuthPublicKeyProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    let key: NebiusAuthPublicKeySchema.AuthPublicKey | undefined
    if (output?.id) {
      key = yield* iam.authPublicKey
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!key) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.iam.v1.AuthPublicKey (${name})`)
      key = yield* iam.authPublicKey.create({
        metadata: { parentId, name, labels },
        spec: NebiusAuthPublicKeySchema.AuthPublicKeySpec.fromJSON({
          account: NebiusAccessSchema.Account.fromPartial({
            serviceAccount: { id: news.accountId },
          }),
          description: news.description || '',
          data: news.data,
          ...(news.expiresAt ? { expiresAt: news.expiresAt } : {}),
        }),
      })
    }

    const desired = NebiusAuthPublicKeySchema.AuthPublicKeySpec.fromJSON({
      account: NebiusAccessSchema.Account.fromPartial({
        serviceAccount: { id: news.accountId },
      }),
      description: news.description || '',
      data: news.data,
      ...(news.expiresAt ? { expiresAt: news.expiresAt } : {}),
    })
    if (key.spec && !AlchemyDiff.deepEqual(key.spec, desired)) {
      yield* session.note(`Updating Nebius.iam.v1.AuthPublicKey (${key.metadata!.name})`)
      key = yield* iam.authPublicKey.update({
        metadata: {
          id: key.metadata!.id,
          resourceVersion: key.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(key)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.AuthPublicKey',
    resourceLabel: 'AuthPublicKey',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.authPublicKey.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v1.AuthPublicKey',
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.authPublicKey.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.iam.v1.AuthPublicKey',
    service: IamGrpc.IamGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (project) => project.metadata!.id,
    listByParent: (svc, parentId) => svc.authPublicKey.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.AuthPublicKey.diff')(function* ({ news, olds }) {
    news = news || ({} as AuthPublicKeySchema.AuthPublicKeyProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    if (news.accountId !== olds?.accountId) return { action: 'replace' }
    if (news.data !== olds?.data) return { action: 'replace' }
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
