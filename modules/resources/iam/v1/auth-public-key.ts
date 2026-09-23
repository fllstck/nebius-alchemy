import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusAuthPublicKeySchema from '../../../../schemas/nebius/iam/v1/auth_public_key.ts'
import * as NebiusAccessSchema from '../../../../schemas/nebius/iam/v1/access.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as AuthPublicKeySchema from './auth-public-key.schema.ts'
import * as Factory from '../../factory.ts'
import * as Ids from './ids.ts'

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
  const accountId = (raw.spec?.account?.serviceAccount?.id || '') as unknown as Ids.ServiceAccountId
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

  reconcile: Effect.fn('Nebius.iam.v1.AuthPublicKey.reconcile')(function* ({ id, news, output, session, olds }) {
    news = yield* AuthPublicKeySchema.validateAuthPublicKeyProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    let key: NebiusAuthPublicKeySchema.AuthPublicKey | undefined
    if (output?.id) {
      key = yield* iam.authPublicKey
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!key) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
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
    // Compare the mutable `description`, plus `expiresAt` only when the user pinned it.
    //
    // ⚠️ Live behaviour, probed 2026-09-22: the API does not echo `data` verbatim — it normalizes
    // the PEM (799 chars sent, 800 echoed), so the previous whole-spec `specDeepEqual` differed on
    // every read and wrote an update on EVERY reconcile (`resourceVersion` 1 → 2 across a
    // labels-only reconcile, `Updating Nebius.iam.v1.AuthPublicKey` logged each time).
    // `data`/`accountId` are immutable and a change to either is planned as a REPLACE by `diff`, so
    // ignoring them here loses nothing; `expiresAt` stays compared (guarded on the news side) so a
    // change to it is still written for the API to adjudicate rather than silently dropped.
    if ((

      key.spec &&
      ((key.spec.description ?? '') !== (news.description ?? '') ||
        (news.expiresAt !== undefined &&
          !ResourceUtils.specDeepEqual(key.spec.expiresAt, desired.expiresAt)))
    
    ) ||
    Factory.labelsDrifted(key.metadata?.labels, news.labels, olds?.labels)) {
      yield* session.note(`Updating Nebius.iam.v1.AuthPublicKey (${key.metadata!.name})`)
      key = yield* iam.authPublicKey.update({
        metadata: {
          id: key.metadata!.id,
          resourceVersion: key.metadata!.resourceVersion.toString(),
          labels,
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
    validate: AuthPublicKeySchema.validateAuthPublicKeyProps,
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

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* AuthPublicKeySchema.validateAuthPublicKeyProps(news)
    if (news.accountId !== olds?.accountId) return Factory.replaceKeepingName(news)
    if (news.data !== olds?.data) return Factory.replaceKeepingName(news)
    return Factory.identityChangeRequiresReplace(news, olds)
  }),
})
