import * as Effect from 'effect/Effect'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusSecretVersionSchema from '../../../../schemas/nebius/mysterybox/v1/secret_version.ts'
import * as MysteryBoxGrpc from '../../../api-client/mysterybox.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as SecretVersionSchema from './secret-version.schema.ts'

// ----- RESOURCE TYPES

export type NebiusSecretVersion = Alchemy.Resource<
  'Nebius.mysterybox.v1.SecretVersion',
  SecretVersionSchema.SecretVersionProps,
  SecretVersionSchema.SecretVersionAttributes
>

export const NebiusSecretVersion =
  Alchemy.Resource<NebiusSecretVersion>('Nebius.mysterybox.v1.SecretVersion')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusSecretVersionSchema.SecretVersion,
): SecretVersionSchema.SecretVersionAttributes =>
  ResourceUtils.toFriendlyAttributes<SecretVersionSchema.SecretVersionAttributes>({
    rawResource: raw,
    resourceSchema: NebiusSecretVersionSchema.SecretVersion,
  })

// ----- PROVIDER

export const NebiusSecretVersionProvider = AlchemyProvider.succeed(NebiusSecretVersion, {
  reconcile: Effect.fn('Nebius.mysterybox.v1.SecretVersion.reconcile')(function* ({ id, news, output, session }) {
    news = yield* SecretVersionSchema.validateSecretVersionProps(news)

    const svc = yield* MysteryBoxGrpc.MysteryBoxGrpcService

    let version: NebiusSecretVersionSchema.SecretVersion | undefined
    if (output?.id) {
      version = yield* svc.secretVersion
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!version) {
      const name = `sv-${id.replace(/_/g, '-').toLowerCase().slice(0, 55)}`
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.mysterybox.v1.SecretVersion (${name})`)
      version = yield* svc.secretVersion.create({
        metadata: { parentId: news.parentId, name, labels },
        spec: NebiusSecretVersionSchema.SecretVersionSpec.fromJSON({
          description: news.description || '',
          payload: news.payload,
          ...(news.setPrimary ? { setPrimary: true } : {}),
        }),
      })
    }

    // SecretVersion is immutable after creation — nothing to update
    return toFriendlyAttributes(version)
  }),

  delete: Effect.fn('Nebius.mysterybox.v1.SecretVersion.delete')(function* ({ output, session }) {
    const svc = yield* MysteryBoxGrpc.MysteryBoxGrpcService
    yield* session.note(`Deleting SecretVersion (${output.id})`)
    yield* svc.secretVersion.delete(output.id)
  }),

  read: Effect.fn('Nebius.mysterybox.v1.SecretVersion.read')(function* ({ id, output }) {
    if (!output?.id) return undefined
    const svc = yield* MysteryBoxGrpc.MysteryBoxGrpcService
    const version = yield* svc.secretVersion
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    if (!version) return undefined
    const attrs = toFriendlyAttributes(version)
    if (yield* AlchemyTags.hasAlchemyTags(id, version.metadata?.labels || {})) {
      return attrs
    }
    return Alchemy.AdoptPolicy.Unowned(attrs)
  }),

  // list is per-secret (parentId from props), not project-scoped — return []
  list: Effect.fn('Nebius.mysterybox.v1.SecretVersion.list')(() => Effect.succeed([])),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.mysterybox.v1.SecretVersion.diff')(function* ({ news, olds }) {
    news = news || ({} as SecretVersionSchema.SecretVersionProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    // parentId is immutable (version can't move secrets)
    if (news.parentId !== olds?.parentId) return { action: 'replace' }
    return undefined
  }),
})
