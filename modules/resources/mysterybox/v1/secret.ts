import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'

import * as NebiusSecretSchema from '../../../../schemas/nebius/mysterybox/v1/secret.ts'
import * as NebiusSecretVersionSchema from '../../../../schemas/nebius/mysterybox/v1/secret_version.ts'
import * as NebiusPayloadSchema from '../../../../schemas/nebius/mysterybox/v1/payload.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as MysteryBoxGrpc from '../../../api-client/mysterybox.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as SecretSchema from './secret.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusSecret = Alchemy.Resource<
  'Nebius.mysterybox.v1.Secret',
  SecretSchema.SecretProps,
  SecretSchema.SecretAttributes
>

export const NebiusSecret = Alchemy.Resource<NebiusSecret>('Nebius.mysterybox.v1.Secret')

// ----- HELPERS

const toFriendlyAttributes = (rawSecret: NebiusSecretSchema.Secret): SecretSchema.SecretAttributes =>
  ResourceUtils.toFriendlyAttributes<SecretSchema.SecretAttributes>({
    rawResource: rawSecret,
    resourceSchema: NebiusSecretSchema.Secret,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusSecretProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusSecret>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusSecret>, never, any>)
  : AlchemyProvider.succeed(NebiusSecret, {
  nuke: { skip: true },

  reconcile: Effect.fn('Nebius.mysterybox.v1.Secret.reconcile')(function* ({ id, news, output, session, olds }) {
    news = news || {}
    news = yield* SecretSchema.validateSecretProps(news)

    const grpcService = yield* MysteryBoxGrpc.MysteryBoxGrpcService

    // 1. Observe
    let secret: NebiusSecretSchema.Secret | undefined
    if (output?.id) {
      secret = yield* grpcService.secret
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing
    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!secret) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      // Build initial payload entries
      const payloads = (news.payloads || [{ key: 'placeholder', stringValue: '' }]).map((p) =>
        NebiusPayloadSchema.Payload.fromPartial(p),
      )
      yield* session.note(`Creating Nebius.mysterybox.v1.Secret (${name})`)
      secret = yield* grpcService.secret.create({
        metadata: { parentId, name, labels },
        spec: NebiusSecretSchema.SecretSpec.fromPartial({
          description: news.description || '',
          secretVersion: NebiusSecretVersionSchema.SecretVersionSpec.fromPartial({
            description: 'Initial version',
            payload: payloads,
            setPrimary: true,
          }),
        }),
      })
    }

    // 3. Sync — update if description changed
    if ((
secret.spec && secret.spec.description !== (news.description || '')
    ) ||
    Factory.labelsDrifted(secret.metadata?.labels, news.labels, olds?.labels)) {
      yield* session.note(`Updating Nebius.mysterybox.v1.Secret (${secret.metadata!.name})`)
      secret = yield* grpcService.secret.update({
        metadata: {
          id: secret.metadata!.id,
          resourceVersion: secret.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: NebiusSecretSchema.SecretSpec.fromPartial({
          description: news.description || '',
        }),
      })
    }

    return toFriendlyAttributes(secret)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.mysterybox.v1.Secret',
    resourceLabel: 'Secret',
    service: MysteryBoxGrpc.MysteryBoxGrpcService,
    deleteById: (svc, id) => svc.secret.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.mysterybox.v1.Secret',
    validate: SecretSchema.validateSecretProps,
    service: MysteryBoxGrpc.MysteryBoxGrpcService,
    getById: (svc, id) => svc.secret.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.mysterybox.v1.Secret',
    service: MysteryBoxGrpc.MysteryBoxGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.secret.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.mysterybox.v1.Secret.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* SecretSchema.validateSecretProps(news)
    return Factory.identityChangeRequiresReplace(news, olds)
  }),
})
