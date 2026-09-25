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

  // The container is the **project**, not the service account — measured live 2026-09-25
  // (`spikes/static-key-parent-probe.ts`): `Issue` with `parentId` = an SA is refused outright with
  // `3 INVALID_ARGUMENT: Expected type of nid should be one of project, aiproject, tractotenant, but
  // found serviceaccount`, and the key's `metadata.parentId` is echoed back as the project. The
  // proto's "parent container (service account)" wording on `GetStaticKeyByNameRequest` is wrong for
  // this service: `getByName(PROJECT, name)` finds the key and `getByName(SA, name)` answers
  // `5 NOT_FOUND`. `spec.account.serviceAccount.id` is what names the account.
  const parentId = yield* Config.String('NEBIUS_PROJECT_ID')

  // Auto-generate name: `sk-<logicalId>` — deterministic, so a replacement generation reuses it and
  // the diff must plan delete-first (see `diff` below).
  const name = `sk-${id.replace(/_/g, '-').toLowerCase().slice(0, 55)}`

  yield* session.note(`Issuing static key for service account (${news.serviceAccountId})`)

  // Ownership tags are **load-bearing here**, not decoration. `list` is project-scoped (a key's only
  // container — see below), and `alchemy unsafe nuke` deletes every target a provider's `list`
  // returns without any further ownership check, so a project-scoped list that returns foreign keys
  // would delete credentials this code never created. `Factory.makeTenantScopedList` withholds
  // anything without an `alchemy::` label for exactly that reason (
  // `isDefaultResource`: "system resources untouched by Alchemy have no labels → default"), and
  // measured live 2026-09-25 (`spikes/static-key-parent-probe.ts`) the API stores and echoes these
  // labels verbatim while a tagged key is the *only* one the provider-shaped list returns. Before
  // this, keys were issued with no labels at all — so `read`'s `hasAlchemyTags` check always
  // answered `Unowned` too.
  const labels = yield* AlchemyTags.createInternalTags(id)
  const result = yield* iamGrpcService.staticKey.issue({
    metadata: {
      parentId,
      name,
      labels,
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
  // Keys are enumerated per project (see `list` below) and deleted before their SA. Ordering is
  // defence-in-depth rather than a requirement: the API *does* cascade a key away with the service
  // account it names in `spec.account` — measured live 2026-09-25
  // (`spikes/static-key-parent-probe.ts`: `Delete(serviceAccount)` succeeded with an attached key
  // and a `list(PROJECT)` afterwards answered `[]`), contradicting the "Nebius does not
  // cascade-delete associated resources" note that used to sit here). Deleting the credential
  // explicitly is still the better order: it is visible in the destroy log, and it does not depend
  // on a cascade this family only measured for one shape.
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

  // List **by project** — the same container `create` issues into.
  //
  // This used to fan out project → every service account → `staticKey.list(sa.id)`, on the belief
  // that keys are per-SA. Measured live 2026-09-25 (`spikes/static-key-parent-probe.ts`): the API
  // refuses an SA container on `Issue` (`3 INVALID_ARGUMENT: Expected type of nid should be one of
  // project, aiproject, tractotenant, but found serviceaccount`), stores the key with
  // `metadata.parentId = <project>`, returns it from `list(PROJECT)` and returns **nothing** for
  // `list(SA)`. So the fan-out could never see a single key this provider created — and `list` is
  // what `alchemy unsafe nuke` enumerates, i.e. a nuke reported a clean tenant while leaving
  // long-lived credentials (6 months by default, up to 3 years) behind.
  //
  // Removing the fan-out also drops one RPC per project from an enumeration that walks every family
  // in the tenant. The sibling with this exact proto shape (`metadata.parentId` + a
  // `spec.account.serviceAccount` reference), `iam/v1 AuthPublicKey`, already lists per project.
  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.iam.v1.StaticKey',
    service: IamGrpc.IamGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (project) => project.metadata!.id,
    listByParent: (svc, parentId) => svc.staticKey.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

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
    // issue time in `reconcile` — never in a `precreate`, see `create` above), so
    // `description`/`expiresAt` can only change by REISSUING the key. Replacing
    // makes that visible in the plan instead of silently ignoring the change;
    // delete-first ordering (the physical name is `sk-<logicalId>`) is what keeps
    // the swap legal.
    if (news.description !== olds?.description || String(news.expiresAt) !== String(olds?.expiresAt)) {
      return Factory.replaceSameGeneratedName()
    }

    return undefined
  }),
})
