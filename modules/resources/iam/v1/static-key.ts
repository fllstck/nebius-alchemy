import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusStaticKeySchema from '../../../../schemas/nebius/iam/v1/static_key'
import * as NebiusAccessSchema from '../../../../schemas/nebius/iam/v1/access'
import * as IamGrpc from '../../../api-client/iam'
import * as ResourceUtils from '../../utilities.ts'

import * as StaticKeySchema from './static-key.schema.ts'
import * as Factory from '../../factory.ts'
import * as ServiceAccountSchema from './service-account.schema.ts'

// ----- RESOURCE TYPES

export type NebiusStaticKey = Alchemy.Resource<
  'Nebius.iam.v1.StaticKey',
  StaticKeySchema.StaticKeyProps,
  StaticKeySchema.StaticKeyAttributes
>

export const NebiusStaticKey = Alchemy.Resource<NebiusStaticKey>('Nebius.iam.v1.StaticKey')

// ----- HELPERS

const toFriendlyAttributes = (
  rawKey: NebiusStaticKeySchema.StaticKey,
  token?: string,
): StaticKeySchema.StaticKeyAttributes => {
  const base = ResourceUtils.toFriendlyAttributes<StaticKeySchema.StaticKeyAttributes>({
    rawResource: rawKey,
    resourceSchema: NebiusStaticKeySchema.StaticKey,
  })
  // Extract serviceAccountId from the nested spec.account
  const serviceAccountId =
    (rawKey.spec?.account?.serviceAccount?.id || '') as unknown as ServiceAccountSchema.ServiceAccountId
  // The token (secretKey) is only available from the issue response, not from get.
  if (token) {
    return {
      ...base,
      secretKey: token,
      accessKey: rawKey.metadata?.id || '',
      serviceAccountId,
    }
  }
  return { ...base, serviceAccountId }
}

// ----- PROVIDER

export const NebiusStaticKeyProvider = AlchemyProvider.succeed(NebiusStaticKey, {
  // precreate issues the key and captures the one-time token in output.
  // This ensures the token is always available for downstream consumers.
  precreate: Effect.fn('Nebius.iam.v1.StaticKey.precreate')(function* ({ id, news, session }) {
    news = yield* StaticKeySchema.validateStaticKeyProps(news)

    const iamGrpcService = yield* IamGrpc.IamGrpcService
    const parentId = yield* Config.string('NEBIUS_PROJECT_ID')

    // Auto-generate name
    const name = `sk-${id.replace(/_/g, '-').toLowerCase().slice(0, 55)}`

    yield* session.note(`Issuing static key for service account (${news.serviceAccountId})`)
    const result = yield* iamGrpcService.staticKey.issue({
      metadata: {
        parentId,
        name,
      },
      spec: NebiusStaticKeySchema.StaticKeySpec.fromJSON({
        account: NebiusAccessSchema.Account.fromPartial({
          serviceAccount: { id: news.serviceAccountId },
        }),
        service: news.service || 'OBSERVABILITY',
        ...(news.expiresAt ? { expiresAt: news.expiresAt } : {}),
      }),
    })

    return toFriendlyAttributes(result.key, result.token)
  }),

  reconcile: Effect.fn('Nebius.iam.v1.StaticKey.reconcile')(function* ({ output, session }) {
    // Static keys are immutable — they can't be updated via the API.
    // precreate always runs before reconcile for greenfield deployments,
    // so output should always be populated. If it's not, something went wrong.
    if (!output) {
      return yield* Effect.die(
        `Nebius.iam.v1.StaticKey.reconcile: output is undefined. ` +
          `Static keys must be created via precreate.`,
      )
    }

    const iamGrpcService = yield* IamGrpc.IamGrpcService

    // Observe — check if the key still exists
    const key = yield* iamGrpcService.staticKey
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))

    if (!key) {
      return yield* Effect.die(
        `Nebius.iam.v1.StaticKey.reconcile: key ${output.id} disappeared after precreate. ` +
          `Static keys cannot be re-issued (token is lost). Replace the resource to get a new key.`,
      )
    }

    // No sync — static keys are immutable

    yield* session.note(`Verified static key (${output.id})`)

    // Preserve the token from output (only available at issue time)
    return { ...toFriendlyAttributes(key), secretKey: output.secretKey, accessKey: output.accessKey }
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.StaticKey',
    resourceLabel: 'StaticKey',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.staticKey.delete(id),
  }),

  read: Effect.fn('Nebius.iam.v1.StaticKey.read')(function* ({ id, output }) {
    if (!output?.id) return undefined
    const iamGrpcService = yield* IamGrpc.IamGrpcService

    const key = yield* iamGrpcService.staticKey
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    if (!key) return undefined

    const attrs = toFriendlyAttributes(key, output.secretKey)
    if (yield* AlchemyTags.hasAlchemyTags(id, key.metadata?.labels || {})) {
      return attrs
    }
    return Alchemy.AdoptPolicy.Unowned(attrs)
  }),

  list: Effect.fn('Nebius.iam.v1.StaticKey.list')(function* () {
    // No project-scoped list — static keys are per-service-account.
    yield* Effect.void
    return []
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.StaticKey.diff')(function* ({ news, olds }) {
    news = news || ({} as StaticKeySchema.StaticKeyProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Static keys can't move between service accounts
    if (news.serviceAccountId !== olds?.serviceAccountId) return { action: 'replace' }
    // Service type change requires replace (keys are immutable)
    if (news.service !== olds?.service) return { action: 'replace' }

    return undefined
  }),
})
