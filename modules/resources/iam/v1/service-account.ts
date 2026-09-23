import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'

import * as NebiusServiceAccountSchema from '../../../../schemas/nebius/iam/v1/service_account.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as ServiceAccountSchema from './service-account.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusServiceAccount = Alchemy.Resource<
  'Nebius.iam.v1.ServiceAccount',
  ServiceAccountSchema.ServiceAccountProps,
  ServiceAccountSchema.ServiceAccountAttributes
>

export const NebiusServiceAccount = Alchemy.Resource<NebiusServiceAccount>('Nebius.iam.v1.ServiceAccount')

// ----- HELPERS

const toFriendlyAttributes = (
  rawSA: NebiusServiceAccountSchema.ServiceAccount,
): ServiceAccountSchema.ServiceAccountAttributes =>
  ResourceUtils.toFriendlyAttributes<ServiceAccountSchema.ServiceAccountAttributes>({
    rawResource: rawSA,
    resourceSchema: NebiusServiceAccountSchema.ServiceAccount,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusServiceAccountProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusServiceAccount>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusServiceAccount>, never, any>)
  : AlchemyProvider.succeed(NebiusServiceAccount, {
  reconcile: Effect.fn('Nebius.iam.v1.ServiceAccount.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* ServiceAccountSchema.validateServiceAccountProps(news)

    const iamGrpcService = yield* IamGrpc.IamGrpcService

    // 1. Observe
    let sa: NebiusServiceAccountSchema.ServiceAccount | undefined
    if (output?.id) {
      sa = yield* iamGrpcService.serviceAccount
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing
    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!sa) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      yield* session.note(`Creating Nebius.iam.v1.ServiceAccount (${name})`)
      sa = yield* iamGrpcService.serviceAccount.create({
        metadata: { parentId, name, labels },
        spec: NebiusServiceAccountSchema.ServiceAccountSpec.fromPartial({ description: news.description || '' }),
      })
    }

    // 3. Sync — update if spec drifted
    const desiredSpec = NebiusServiceAccountSchema.ServiceAccountSpec.fromPartial({
      description: news.description || '',
    })
    if (sa.spec && !ResourceUtils.specDeepEqual(sa.spec, desiredSpec)) {
      yield* session.note(`Updating Nebius.iam.v1.ServiceAccount (${sa.metadata!.name})`)
      sa = yield* iamGrpcService.serviceAccount.update({
        metadata: {
          id: sa.metadata!.id,
          resourceVersion: sa.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: desiredSpec,
      })
    }

    return toFriendlyAttributes(sa)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.ServiceAccount',
    resourceLabel: 'ServiceAccount',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.serviceAccount.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v1.ServiceAccount',
    validate: ServiceAccountSchema.validateServiceAccountProps,
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.serviceAccount.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.iam.v1.ServiceAccount',
    service: IamGrpc.IamGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.serviceAccount.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.ServiceAccount.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* ServiceAccountSchema.validateServiceAccountProps(news)
    return Factory.identityChangeRequiresReplace(news, olds)
  }),
})
