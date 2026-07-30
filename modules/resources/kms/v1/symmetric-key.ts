import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusSymmetricKeySchema from '../../../../schemas/nebius/kms/v1/symmetric_key'
import * as IamGrpc from '../../../api-client/iam'
import * as KmsGrpc from '../../../api-client/kms'
import * as ResourceUtils from '../../utilities.ts'

import * as SymmetricKeySchema from './symmetric-key.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusSymmetricKey = Alchemy.Resource<
  'Nebius.kms.v1.SymmetricKey',
  SymmetricKeySchema.SymmetricKeyProps,
  SymmetricKeySchema.SymmetricKeyAttributes
>

export const NebiusSymmetricKey = Alchemy.Resource<NebiusSymmetricKey>('Nebius.kms.v1.SymmetricKey')

// ----- HELPERS

const toFriendlyAttributes = (
  rawKey: NebiusSymmetricKeySchema.SymmetricKey,
): SymmetricKeySchema.SymmetricKeyAttributes =>
  ResourceUtils.toFriendlyAttributes<SymmetricKeySchema.SymmetricKeyAttributes>({
    rawResource: rawKey,
    resourceSchema: NebiusSymmetricKeySchema.SymmetricKey,
  })

// ----- PROVIDER

export const NebiusSymmetricKeyProvider = AlchemyProvider.succeed(NebiusSymmetricKey, {
  reconcile: Effect.fn('Nebius.kms.v1.SymmetricKey.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* SymmetricKeySchema.validateSymmetricKeyProps(news)

    const grpcService = yield* KmsGrpc.KmsGrpcService

    // 1. Observe
    let key: NebiusSymmetricKeySchema.SymmetricKey | undefined
    if (output?.id) {
      key = yield* grpcService.symmetricKey
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing
    if (!key) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.kms.v1.SymmetricKey (${name})`)
      key = yield* grpcService.symmetricKey.create({
        metadata: { parentId, name, labels },
        spec: NebiusSymmetricKeySchema.SymmetricKeySpec.fromJSON({
          description: news.description || '',
          algorithm: news.algorithm || 'AES_256',
        }),
      })
    }

    // 3. Sync — only description can change (algorithm is immutable)
    const desiredSpec = NebiusSymmetricKeySchema.SymmetricKeySpec.fromJSON({
      description: news.description || '',
      algorithm: output?.algorithm || news.algorithm || 'AES_256',
    })
    if (key.spec && !AlchemyDiff.deepEqual(
      { description: key.spec.description },
      { description: desiredSpec.description },
    )) {
      yield* session.note(`Updating Nebius.kms.v1.SymmetricKey (${key.metadata!.name})`)
      key = yield* grpcService.symmetricKey.update({
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
    resourceName: 'Nebius.kms.v1.SymmetricKey',
    resourceLabel: 'SymmetricKey',
    service: KmsGrpc.KmsGrpcService,
    deleteById: (svc, id) => svc.symmetricKey.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.kms.v1.SymmetricKey',
    service: KmsGrpc.KmsGrpcService,
    getById: (svc, id) => svc.symmetricKey.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.kms.v1.SymmetricKey',
    service: KmsGrpc.KmsGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.symmetricKey.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.kms.v1.SymmetricKey.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Algorithm is immutable — changing requires replace
    if (news.algorithm !== olds?.algorithm) return { action: 'replace' }
    if (news.name !== olds?.name) return { action: 'replace' }

    return undefined
  }),
})
