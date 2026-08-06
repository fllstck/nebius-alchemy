import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'

import * as NebiusAccessKeyV2Schema from '../../../../schemas/nebius/iam/v2/access_key.ts'
import * as NebiusAccessSchema from '../../../../schemas/nebius/iam/v1/access.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as AccessKeySchema from './access-key.schema.ts'
import * as Factory from '../../factory.ts'
import * as ServiceAccountSchema from '../v1/service-account.schema.ts'

// ----- RESOURCE TYPES

export type NebiusAccessKey = Alchemy.Resource<
  'Nebius.iam.v2.AccessKey',
  AccessKeySchema.AccessKeyProps,
  AccessKeySchema.AccessKeyAttributes
>

export const NebiusAccessKey = Alchemy.Resource<NebiusAccessKey>('Nebius.iam.v2.AccessKey')

// ----- HELPERS

const toFriendlyAttributes = (
  rawKey: NebiusAccessKeyV2Schema.AccessKey,
  secret?: string,
): AccessKeySchema.AccessKeyAttributes => {
  const base = ResourceUtils.toFriendlyAttributes<AccessKeySchema.AccessKeyAttributes>({
    rawResource: rawKey,
    resourceSchema: NebiusAccessKeyV2Schema.AccessKey,
  })
  // Extract serviceAccountId from the nested spec.account
  const serviceAccountId =
    (rawKey.spec?.account?.serviceAccount?.id || '') as unknown as ServiceAccountSchema.ServiceAccountId
  // Derive secretDeliveryMode from the spec (encoded as enum number, toJSON gives string)
  const deliveryMode = (rawKey.spec?.secretDeliveryMode != null
    ? NebiusAccessKeyV2Schema.secretDeliveryModeToJSON(rawKey.spec.secretDeliveryMode)
    : 'INLINE') as AccessKeySchema.SecretDeliveryMode
  // The secret is only available at creation time. Preserve it if we have it.
  if (secret) {
    return { ...base, secretAccessKey: secret, serviceAccountId, secretDeliveryMode: deliveryMode }
  }
  return { ...base, secretAccessKey: '', serviceAccountId, secretDeliveryMode: deliveryMode }
}

// ----- PROVIDER

interface CreateInput {
  id: string
  news: AccessKeySchema.AccessKeyProps
  session: { note(message: string): Effect.Effect<void> }
}

/** Create the key + capture the one-time secret (shared by the create path). */
const create = Effect.fn('Nebius.iam.v2.AccessKey.create')(function* ({
  id,
  news,
  session,
}: CreateInput) {
  news = yield* AccessKeySchema.validateAccessKeyProps(news)

  const iamGrpcService = yield* IamGrpc.IamGrpcService
  const parentId = yield* Config.string('NEBIUS_PROJECT_ID')

  // Auto-generate name
  const name = `ak-${id.replace(/_/g, '-').toLowerCase().slice(0, 55)}`

  // Map secretDeliveryMode string to proto enum
  const secretDeliveryMode: NebiusAccessKeyV2Schema.SecretDeliveryMode =
    news.secretDeliveryMode === 'MYSTERY_BOX'
      ? NebiusAccessKeyV2Schema.SecretDeliveryMode.MYSTERY_BOX
      : news.secretDeliveryMode === 'EXPLICIT'
        ? NebiusAccessKeyV2Schema.SecretDeliveryMode.EXPLICIT
        : NebiusAccessKeyV2Schema.SecretDeliveryMode.INLINE

  // Step 1: Create the access key (operation-backed, polls internally).
  yield* session.note(`Creating access key for service account (${news.serviceAccountId})`)
  const key = yield* iamGrpcService.accessKeyV2.create({
    metadata: {
      parentId,
      name,
    },
    spec: NebiusAccessKeyV2Schema.AccessKeySpec.fromJSON({
      account: NebiusAccessSchema.Account.fromPartial({
        serviceAccount: { id: news.serviceAccountId },
      }),
      description: news.description || '',
      ...(news.expiresAt ? { expiresAt: news.expiresAt } : {}),
      secretDeliveryMode: NebiusAccessKeyV2Schema.secretDeliveryModeToJSON(secretDeliveryMode),
    }),
  })

  // Step 2: Fetch the one-time secret (for non-MYSTERY_BOX modes)
  let secret = ''
  if (secretDeliveryMode !== NebiusAccessKeyV2Schema.SecretDeliveryMode.MYSTERY_BOX) {
    secret = yield* iamGrpcService.accessKeyV2.getSecret(key.metadata!.id)
  }

  return toFriendlyAttributes(key, secret)
})

export const NebiusAccessKeyProvider = AlchemyProvider.succeed(NebiusAccessKey, {
  reconcile: Effect.fn('Nebius.iam.v2.AccessKey.reconcile')(function* ({ id, news, output, session }) {
    // Access keys are largely immutable — only description can be updated.
    // Creation happens HERE (in reconcile) — not in a precreate — because
    // reconcile runs after waitForDeps + Output.evaluate, so the SA ref in
    // the props is RESOLVED. A precreate would receive raw props with an
    // unresolved `serviceAccountId` and fail whenever the key is declared in
    // the same deploy as its SA (the binding hostIdentity chain).
    if (!output) {
      return yield* create({ id, news, session })
    }

    news = news || {}
    news = yield* AccessKeySchema.validateAccessKeyProps(news)

    const iamGrpcService = yield* IamGrpc.IamGrpcService

    // Observe — check if the key still exists
    const key = yield* iamGrpcService.accessKeyV2
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))

    if (!key) {
      return yield* Effect.die(
        `Nebius.iam.v2.AccessKey.reconcile: key ${output.id} disappeared. ` +
          `Access keys cannot be re-created (secret is lost). Replace the resource to get a new key.`,
      )
    }

    // Sync — update if description changed (only mutable field)
    yield* session.note(`Verified access key (${output.id})`)
    const desiredSpec = NebiusAccessKeyV2Schema.AccessKeySpec.fromJSON({
      account: NebiusAccessSchema.Account.fromPartial({
        serviceAccount: { id: news.serviceAccountId },
      }),
      description: news.description || '',
      ...(news.expiresAt ? { expiresAt: news.expiresAt } : {}),
      secretDeliveryMode: news.secretDeliveryMode || 'INLINE',
    })
    if (key.spec && !AlchemyDiff.deepEqual(key.spec, desiredSpec)) {
      yield* iamGrpcService.accessKeyV2.update({
        metadata: {
          id: key.metadata!.id,
          resourceVersion: key.metadata!.resourceVersion.toString(),
        },
        spec: desiredSpec,
      })
    }

    // Preserve the secret from output (only available at creation time)
    return toFriendlyAttributes(key, output.secretAccessKey)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v2.AccessKey',
    resourceLabel: 'AccessKey',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.accessKeyV2.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v2.AccessKey',
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.accessKeyV2.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.iam.v2.AccessKey',
    service: IamGrpc.IamGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (project) => project.metadata!.id,
    listByParent: (svc, parentId) => svc.accessKeyV2.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v2.AccessKey.diff')(function* ({ news, olds }) {
    news = news || ({} as AccessKeySchema.AccessKeyProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Access keys can't move between service accounts
    if (news.serviceAccountId !== olds?.serviceAccountId) return { action: 'replace' }

    // secretDeliveryMode is immutable (defaults to INLINE when not set)
    const newsDeliveryMode = news.secretDeliveryMode ?? 'INLINE'
    if (newsDeliveryMode !== (olds?.secretDeliveryMode ?? 'INLINE')) return { action: 'replace' }

    return undefined
  }),
})
