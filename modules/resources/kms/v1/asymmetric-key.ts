import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusAsymmetricKeySchema from '../../../../schemas/nebius/kms/v1/asymmetric_key.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as KmsGrpc from '../../../api-client/kms.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as AsymmetricKeySchema from './asymmetric-key.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusAsymmetricKey = Alchemy.Resource<
  'Nebius.kms.v1.AsymmetricKey',
  AsymmetricKeySchema.AsymmetricKeyProps,
  AsymmetricKeySchema.AsymmetricKeyAttributes
>

export const NebiusAsymmetricKey = Alchemy.Resource<NebiusAsymmetricKey>('Nebius.kms.v1.AsymmetricKey')

// ----- HELPERS

const toFriendlyAttributes = (
  rawKey: NebiusAsymmetricKeySchema.AsymmetricKey,
): AsymmetricKeySchema.AsymmetricKeyAttributes =>
  ResourceUtils.toFriendlyAttributes<AsymmetricKeySchema.AsymmetricKeyAttributes>({
    rawResource: rawKey,
    resourceSchema: NebiusAsymmetricKeySchema.AsymmetricKey,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusAsymmetricKeyProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusAsymmetricKey>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusAsymmetricKey>, never, any>)
  : AlchemyProvider.succeed(NebiusAsymmetricKey, {
  reconcile: Effect.fn('Nebius.kms.v1.AsymmetricKey.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* AsymmetricKeySchema.validateAsymmetricKeyProps(news)

    const grpcService = yield* KmsGrpc.KmsGrpcService

    // 1. Observe
    let key: NebiusAsymmetricKeySchema.AsymmetricKey | undefined
    if (output?.id) {
      key = yield* grpcService.asymmetricKey
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure
    if (!key) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.kms.v1.AsymmetricKey (${name})`)
      key = yield* grpcService.asymmetricKey.create({
        metadata: { parentId, name, labels },
        spec: NebiusAsymmetricKeySchema.AsymmetricKeySpec.fromJSON({
          description: news.description || '',
          algorithm: news.algorithm || 'ECDSA_NIST_P256_SHA_256',
        }),
      })
    }

    // 3. Sync — only description can change (algorithm is immutable)
    const desiredSpec = NebiusAsymmetricKeySchema.AsymmetricKeySpec.fromJSON({
      description: news.description || '',
      algorithm: output?.algorithm || news.algorithm || 'ECDSA_NIST_P256_SHA_256',
    })
    if (key.spec && !AlchemyDiff.deepEqual(
      { description: key.spec.description },
      { description: desiredSpec.description },
    )) {
      yield* session.note(`Updating Nebius.kms.v1.AsymmetricKey (${key.metadata!.name})`)
      key = yield* grpcService.asymmetricKey.update({
        metadata: {
          id: key.metadata!.id,
          resourceVersion: key.metadata!.resourceVersion.toString(),
        },
        spec: desiredSpec,
      })
    }

    return toFriendlyAttributes(key)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.kms.v1.AsymmetricKey',
    resourceLabel: 'AsymmetricKey',
    service: KmsGrpc.KmsGrpcService,
    deleteById: (svc, id) => svc.asymmetricKey.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.kms.v1.AsymmetricKey',
    validate: AsymmetricKeySchema.validateAsymmetricKeyProps,
    service: KmsGrpc.KmsGrpcService,
    getById: (svc, id) => svc.asymmetricKey.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.kms.v1.AsymmetricKey',
    service: KmsGrpc.KmsGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.asymmetricKey.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.kms.v1.AsymmetricKey.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* AsymmetricKeySchema.validateAsymmetricKeyProps(news)

    if (news.algorithm !== olds?.algorithm) return { action: 'replace' }
    if (news.name !== olds?.name) return { action: 'replace' }

    return undefined
  }),
})
