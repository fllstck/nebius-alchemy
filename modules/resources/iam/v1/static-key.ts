import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusStaticKeySchema from '../../../../schemas/nebius/iam/v1/static_key.ts'
import * as NebiusAccessSchema from '../../../../schemas/nebius/iam/v1/access.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as StaticKeySchema from './static-key.schema.ts'
import * as Factory from '../../factory.ts'
import { resolveTenantId } from '../../shared/tenant.ts'
import * as Ids from './ids.ts'

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
    (rawKey.spec?.account?.serviceAccount?.id || '') as unknown as Ids.ServiceAccountId
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

interface CreateInput {
  id: string
  news: StaticKeySchema.StaticKeyProps
  session: { note(message: string): Effect.Effect<void> }
}

/**
 * Issue the key and capture the one-time token (the create path).
 *
 * ⚠️ This runs in `reconcile`, NOT in a `precreate`. `precreate` receives **raw props** — it runs
 * before `waitForDeps` + `Output.evaluate` resolve references — so a static key declared in the same
 * deploy as its service account failed with
 * `PropsValidationError: Expected string at ["serviceAccountId"]`, and the half-written state row it
 * left behind then blocked the entire destroy plan (`Skipping delete — blocked by failed delete of …`).
 * `reconcile` runs after references are resolved, and the one-time capture works identically there
 * (the token rides on the `Issue` response). Same reasoning and shape as `iam/v2 AccessKey`, whose
 * binding `hostIdentity` chain depends on it. See TASKS.md §F.
 *
 * `@__PURE__` + `Effect.fn`: the annotation keeps this deploy-only helper droppable from runtime
 * bundles (see TASKS.md §D8).
 */
const create = /* @__PURE__ */ Effect.fn('Nebius.iam.v1.StaticKey.create')(function* ({
  id,
  news,
  session,
}: CreateInput) {
  news = yield* StaticKeySchema.validateStaticKeyProps(news)

  const iamGrpcService = yield* IamGrpc.IamGrpcService
  const parentId = yield* Config.String('NEBIUS_PROJECT_ID')

  // Auto-generate name: `sk-<logicalId>` — deterministic, so a replacement generation reuses it and
  // the diff must plan delete-first (see `diff` below).
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
})

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusStaticKeyProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusStaticKey>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusStaticKey>, never, any>)
  : AlchemyProvider.succeed(NebiusStaticKey, {
  // Nebius does not cascade-delete associated resources on SA delete, so the
  // SA must outlive every key: nuke deletes static keys before their SA.
  nuke: { dependsOn: ['Nebius.iam.v1.ServiceAccount'] },

  reconcile: Effect.fn('Nebius.iam.v1.StaticKey.reconcile')(function* ({ id, news, output, session }) {
    // Static keys are immutable — there is no Update RPC. Creation happens HERE (in reconcile), not
    // in a `precreate`, so a key declared in the same deploy as its service account works — see
    // `create` above for the failure mode that shaped this.
    if (!output) {
      return yield* create({ id, news, session })
    }

    const iamGrpcService = yield* IamGrpc.IamGrpcService

    // Observe — check if the key still exists
    const key = yield* iamGrpcService.staticKey
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))

    if (!key) {
      return yield* Effect.die(
        `Nebius.iam.v1.StaticKey.reconcile: key ${output.id} disappeared. ` +
          `Static keys cannot be re-issued — the token is only returned by Issue and is lost — so ` +
          `replace the resource to get a new key.`,
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

  read: Effect.fn('Nebius.iam.v1.StaticKey.read')(function* ({ id, olds: props, output }) {
    if (!output?.id) {
      // Plan-time props validation for greenfield — `read` is the only provider
      // hook alchemy calls when there is no persisted state (see makeCrudRead).
      if (props != null) yield* StaticKeySchema.validateStaticKeyProps(props)
      return undefined
    }
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

  // Static keys are per-service-account, not per-project — enumerate every SA
  // in the tenant and fan out to each SA's keys. Without this, nuke can't see
  // static keys and would leak long-lived credentials (default 6 months, up to
  // 3 years) when it deletes the SA.
  list: Effect.fn('Nebius.iam.v1.StaticKey.list')(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    const projects = yield* iam.project.list(tenantId)
    const rows = yield* Effect.forEach(projects, (project) =>
      iam.serviceAccount.list(project.metadata!.id).pipe(
        Effect.flatMap((sas) =>
          Effect.forEach(sas, (sa) =>
            iam.staticKey.list(sa.metadata!.id).pipe(
              Effect.map((keys) => keys.map((k) => toFriendlyAttributes(k))),
              Effect.catch(() => Effect.succeed([] as StaticKeySchema.StaticKeyAttributes[])),
            ),
          ),
        ),
        Effect.map((nested) => nested.flat()),
        Effect.catch(() => Effect.succeed([] as StaticKeySchema.StaticKeyAttributes[])),
      ),
    )
    return rows.flat()
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.StaticKey.diff')(function* ({ news, olds }) {
    news = news || ({} as StaticKeySchema.StaticKeyProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* StaticKeySchema.validateStaticKeyProps(news)

    // Spec-only changes: the name is `sk-<logicalId>` on EVERY generation, so
    // there is no fresh generated name to fall back on — always delete-first.
    if (news.serviceAccountId !== olds?.serviceAccountId) return Factory.replaceSameGeneratedName()
    // Service type change requires replace (keys are immutable)
    if (news.service !== olds?.service) return Factory.replaceSameGeneratedName()

    // Issue-only API: there is no update RPC (the one-time token is captured at
    // issue time in `precreate`), so `description`/`expiresAt` can only change by
    // REISSUING the key. Replacing makes that visible in the plan instead of
    // silently ignoring the change; delete-first ordering (the physical name is
    // `sk-<logicalId>`) is what keeps the swap legal.
    if (news.description !== olds?.description || String(news.expiresAt) !== String(olds?.expiresAt)) {
      return Factory.replaceSameGeneratedName()
    }

    return undefined
  }),
})
