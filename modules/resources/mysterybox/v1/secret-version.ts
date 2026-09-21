import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusSecretVersionSchema from '../../../../schemas/nebius/mysterybox/v1/secret_version.ts'
import type { GrpcError } from '../../../api-client/grpc-utils.ts'
import { GrpcError as GrpcErrorCtor } from '../../../api-client/grpc-utils.ts'
import * as MysteryBoxGrpc from '../../../api-client/mysterybox.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as SecretVersionSchema from './secret-version.schema.ts'
import * as Factory from '../../factory.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

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

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusSecretVersionProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusSecretVersion>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusSecretVersion>, never, any>)
  : AlchemyProvider.succeed(NebiusSecretVersion, {
  // Secret versions are children of a Secret — nuke deletes versions before
  // their secret.
  nuke: { dependsOn: ['Nebius.mysterybox.v1.Secret'] },

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
      // `metadata.name` is immutable — the service has no Update RPC (see
      // `diff`) — so it is part of the version's identity. The fallback is
      // deterministic (`sv-<logicalId>`, no random suffix), which is why a
      // spec-only replace must be delete-first: every generation asks for the
      // same name.
      const name = news.name ?? `sv-${id.replace(/_/g, '-').toLowerCase().slice(0, 55)}`
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
    // Idempotent delete: NOT_FOUND means the version is already gone (the
    // server cascade-deletes versions when the parent Secret is removed) —
    // treat it as success, mirroring Factory.makeCrudDelete.
    yield* svc.secretVersion.delete(output.id).pipe(
      Effect.catchIf(
        (e: unknown): e is GrpcError => e instanceof GrpcErrorCtor && e.code === 5,
        () => Effect.void,
      ),
    )
  }),

  read: Effect.fn('Nebius.mysterybox.v1.SecretVersion.read')(function* ({ id, olds: props, output }) {
    if (!output?.id) {
      // Plan-time props validation for greenfield — `read` is the only provider
      // hook alchemy calls when there is no persisted state (see makeCrudRead).
      if (props != null) yield* SecretVersionSchema.validateSecretVersionProps(props)
      return undefined
    }
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

  // Secret versions are children of a Secret — enumerate every secret in the
  // tenant and list each secret's versions (kept consistent with Secret.list;
  // Secret itself is nuke: skip, so this only matters if that ever changes).
  list: Effect.fn('Nebius.mysterybox.v1.SecretVersion.list')(function* () {
    const mysterybox = yield* MysteryBoxGrpc.MysteryBoxGrpcService
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    const projects = yield* iam.project.list(tenantId)
    const rows = yield* Effect.forEach(projects, (project) =>
      mysterybox.secret.list(project.metadata!.id).pipe(
        Effect.flatMap((secrets) =>
          Effect.forEach(secrets, (secret) =>
            mysterybox.secretVersion.list(secret.metadata!.id).pipe(
              Effect.map((versions) => versions.map((v) => toFriendlyAttributes(v))),
              Effect.catch(() => Effect.succeed([] as SecretVersionSchema.SecretVersionAttributes[])),
            ),
          ),
        ),
        Effect.map((nested) => nested.flat()),
        Effect.catch(() => Effect.succeed([] as SecretVersionSchema.SecretVersionAttributes[])),
      ),
    )
    return rows.flat()
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.mysterybox.v1.SecretVersion.diff')(function* ({ news, olds }) {
    news = news || ({} as SecretVersionSchema.SecretVersionProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* SecretVersionSchema.validateSecretVersionProps(news)

    // The service has NO Update RPC (Create/Get/List/Delete/Undelete), so
    // `description`, `payload` and `setPrimary` are immutable: a change can only
    // land by replacing the version. Comparing just the identity — all this diff
    // used to do — planned an `update` that wrote nothing, silently losing the
    // change (AGENTS.md §Convergence).
    //
    // Normalised the same way `reconcile` sends the spec (`description || ''`,
    // `setPrimary` only when truthy), so an absent prop and its falsy default are
    // the same version — compared raw they would plan a destructive replace for a
    // no-op refactor. `labels` is the one declared exception and stays out of the
    // comparison (no update path sends labels anywhere).
    const specChanged =
      (news.description ?? '') !== (olds?.description ?? '') ||
      Boolean(news.setPrimary) !== Boolean(olds?.setPrimary) ||
      !AlchemyDiff.deepEqual(news.payload, olds?.payload)

    // Identity first: a name/parent change is a DIFFERENT version, where
    // create-first is safe (the names differ, or the parent does — Nebius names
    // are unique per parent). A spec-only change reuses the name —
    // `sv-<logicalId>`, or a pinned `news.name`, on every generation — so it must
    // be delete-first or the create hits ALREADY_EXISTS.
    return (
      Factory.identityChangeRequiresReplace(news, olds) ??
      (specChanged ? Factory.replaceSameGeneratedName() : undefined)
    )
  }),
})
