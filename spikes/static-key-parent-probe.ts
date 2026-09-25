/**
 * Which container owns an `iam/v1 StaticKey` — the **project** or the **service account**? (R-21)
 *
 * `Nebius.iam.v1.StaticKey.list` fans out project → service accounts → `staticKey.list(sa.id)`, but
 * `create` issues the key with `metadata.parentId = <project>`. `spikes/idempotency-key-probe.ts`
 * measured the two halves disagree (`byProjectParent: 2, bySaParent: 0`, and an immediate
 * `list(saId)` returned nothing), which is why `alchemy unsafe nuke` cannot see a key this code
 * created — a long-lived credential (6 months by default, up to 3 years) surviving a "clean" nuke.
 *
 * The proto is ambiguous in exactly the way that matters: `GetStaticKeyByNameRequest.parent_id` is
 * documented as "id of the parent container (**service account**)" and `ListStaticKeysRequest.parent_id`
 * only as "Represents the container ID." So the API is the only authority — this probe asks it.
 *
 * Readings it produces, in one run, against one throwaway service account:
 *
 *   A. issue(parentId = PROJECT, name = N_A)  → does it work, and what is the key's stored parent?
 *   B. issue(parentId = SA,      name = N_B)  → does the API accept an SA as the issue parent at all?
 *   C. issue(parentId = PROJECT, name = N_C, labels = alchemy::*) → are ownership labels accepted and
 *                                              echoed? (This is the half that decides whether fixing
 *                                              the parent is safe: nuke deletes *every* target a
 *                                              provider's `list` returns, so a project-scoped list
 *                                              that cannot tell its own keys from somebody else's
 *                                              would delete hand-made credentials.)
 *   list(PROJECT) / list(SA)                  → which keys does each parent actually return?
 *   getByName(PROJECT|SA, N_A|N_B)            → the sync path in `makeStaticKeyService.issue`
 *                                               (`getByName(parentId = req.metadata.parentId)`), so
 *                                               a mismatch there is a latent break in create.
 *   provider-equivalent list                  → `Factory.makeTenantScopedList` with this service, i.e.
 *                                               the fixed provider's `list`: must return C (tagged) and
 *                                               withhold A (untagged — a foreign key's stand-in).
 *   delete SA with keys attached              → refused (FAILED_PRECONDITION / not-empty) or a cascade?
 *
 * The verdict names the (create parent, list parent) pair the API honours; the *fix* then aligns the
 * provider on that pair — the repo's sibling for this exact proto shape, `iam/v1 AuthPublicKey`
 * (`metadata.parentId` + `spec.account.serviceAccount.id`), already creates AND lists by project.
 *
 *   bun spikes/static-key-parent-probe.ts
 */

import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as IamGrpcModule from '../modules/api-client/iam.ts'
import * as FactoryModule from '../modules/resources/factory.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as AccessSchema from '../schemas/nebius/iam/v1/access.ts'
import * as StaticKeySchema from '../schemas/nebius/iam/v1/static_key.ts'
import * as StaticKeyServiceSchema from '../schemas/nebius/iam/v1/static_key_service.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { IamGrpcService, IamGrpcServiceLive } = IamGrpcModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { fromAuthProvider } = NebiusCredentialsModule

// No default: the previous probes hardcoded the maintainer's real project id (R-18, whose acceptance
// grep was scoped to `tests/` and so missed `spikes/`). Read it from the environment.
const PROJECT_ID = process.env.NEBIUS_PROJECT_ID
if (!PROJECT_ID) {
  console.error('NEBIUS_PROJECT_ID is required — no default is committed (R-18). Set it in .env.')
  process.exit(1)
}

const RUN = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()
const PREFIX = 'alchemy-sk-parent-probe'
const SA_NAME = `${PREFIX}-${RUN}`
const NAME_A = `${PREFIX}-project-${RUN}`.slice(0, 62)
const NAME_B = `${PREFIX}-sa-${RUN}`.slice(0, 62)
const NAME_C = `${PREFIX}-tagged-${RUN}`.slice(0, 62)

/** The ownership labels `createInternalTags` mints — inlined so the probe does not need Stack/Stage. */
const OWNERSHIP_LABELS = {
  'alchemy::stack': 'parent-probe',
  'alchemy::stage': 'probe',
  'alchemy::id': 'probe-logical-id',
} as const

/**
 * Exactly what `NebiusStaticKeyProvider.list` is: the same factory call, the same accessors. Running
 * it here is what makes the acceptance end-to-end — it exercises the project fan-out, the project
 * `listByParent`, the attribute mapping **and** `isDefaultResource`, which withholds any key that
 * carries no `alchemy::` label.
 */
const providerShapedList = FactoryModule.makeTenantScopedList({
  resourceName: 'Nebius.iam.v1.StaticKey',
  service: IamGrpcModule.IamGrpcService,
  iamService: IamGrpcModule.IamGrpcService,
  projectList: (svc, tenant) => svc.project.list(tenant),
  projectId: (project) => project.metadata!.id,
  listByParent: (svc, parentId) => svc.staticKey.list(parentId),
  toAttrs: (raw) => ({ id: raw.metadata!.id, name: raw.metadata!.name, labels: raw.metadata?.labels }),
})

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (label: string, value?: unknown) =>
  console.log(`[${stamp()}] ${label}${value === undefined ? '' : `: ${typeof value === 'string' ? value : JSON.stringify(value)}`}`)

const authLayer = Layer.mergeAll(ProfileStoreLive, NebiusAuthModule.NebiusAuth).pipe(
  Layer.provide(CredentialsStoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      PlatformNode.NodeServices.layer,
      SaTokenModule.SaTokenMinterLive,
      SaBootstrapModule.SaBootstrapLive,
    ),
  ),
)

/** The generated `StaticKeyService` surface at the raw-request level, for `getByName`. */
interface RawStaticKeyMethods {
  readonly getByName: (
    req: StaticKeyServiceSchema.GetStaticKeyByNameRequest,
  ) => Effect.Effect<StaticKeySchema.StaticKey, unknown>
}

interface KeyReading {
  readonly arm: string
  readonly id: string
  readonly name: string
  readonly storedParentId: string
  readonly specServiceAccountId: string
  readonly labels: Record<string, string>
}

const readKey = (arm: string, key: StaticKeySchema.StaticKey): KeyReading => ({
  arm,
  id: key.metadata?.id ?? '',
  name: key.metadata?.name ?? '',
  storedParentId: key.metadata?.parentId ?? '',
  specServiceAccountId: key.spec?.account?.serviceAccount?.id ?? '',
  labels: key.metadata?.labels ?? {},
})

const spec = (serviceAccountId: string) =>
  StaticKeySchema.StaticKeySpec.fromJSON({
    account: AccessSchema.Account.fromPartial({ serviceAccount: { id: serviceAccountId } }),
    service: 'OBSERVABILITY',
  })

const program = Effect.gen(function* () {
  const iam = yield* IamGrpcService
  const raw = iam.staticKey as unknown as RawStaticKeyMethods

  // ── Preflight: refuse to run over a leftover probe service account ─────────
  const existing = yield* iam.serviceAccount.list(PROJECT_ID)
  const leftovers = existing.filter((sa) => (sa.metadata?.name ?? '').startsWith(PREFIX))
  if (leftovers.length > 0) {
    log('ABORT — leftover probe service accounts; delete them first', leftovers.map((sa) => sa.metadata?.id))
    return
  }

  const created = yield* iam.serviceAccount
    .create({ metadata: { parentId: PROJECT_ID, name: SA_NAME }, spec: {} })
    .pipe(
      Effect.map((sa) => sa.metadata!.id),
      Effect.catch((error) =>
        Effect.sync(() => {
          log('service-account create failed', String(error).slice(0, 200))
          return undefined
        }),
      ),
    )
  if (created === undefined) {
    log('ABORT — the probe needs its own service account to delete it at the end')
    return
  }
  const saId = created
  log('created probe service account', { id: saId, name: SA_NAME })

  const readings: KeyReading[] = []
  const failures: Array<{ arm: string; error: string }> = []

  const issue = (arm: string, parentId: string, name: string, labels?: Record<string, string>) =>
    Effect.gen(function* () {
      const response = yield* iam.staticKey
        .issue({ metadata: { parentId, name, ...(labels ? { labels } : {}) }, spec: spec(saId) })
        .pipe(
          Effect.catch((error) => {
            failures.push({ arm, error: String(error).slice(0, 300) })
            return Effect.succeed(undefined)
          }),
        )
      if (response === undefined) {
        log(`${arm}: REJECTED`, failures.at(-1)?.error)
        return
      }
      const reading = readKey(arm, response.key)
      readings.push(reading)
      log(`${arm}: ACCEPTED`, {
        ...reading,
        tokenLength: response.token.length,
        labels: response.key.metadata?.labels ?? {},
      })
    })

  const listByName = (parentId: string, label: string) =>
    Effect.gen(function* () {
      const keys = yield* iam.staticKey.list(parentId).pipe(
        Effect.catch((error) => {
          log(`list(${label}) FAILED`, String(error).slice(0, 200))
          return Effect.succeed([] as StaticKeySchema.StaticKey[])
        }),
      )
      const probe = keys.filter((k) => (k.metadata?.name ?? '').startsWith(PREFIX))
      log(`list(${label})`, {
        totalReturned: keys.length,
        probeKeys: probe.map((k) => `${k.metadata?.name}@${k.metadata?.parentId}`),
      })
      return { label, parentId, probe }
    })

  const getByName = (parentId: string, parentLabel: string, name: string) =>
    Effect.gen(function* () {
      const found = yield* raw
        .getByName(StaticKeyServiceSchema.GetStaticKeyByNameRequest.fromPartial({ parentId, name }))
        .pipe(
          Effect.map((key) => key.metadata?.id ?? 'found-but-no-id'),
          Effect.catch((error) => Effect.succeed(`ERROR ${String(error).slice(0, 120)}`)),
        )
      log(`getByName(${parentLabel}, ${name})`, found)
      return found
    })

  let cascadeReading = 'not measured'

  yield* Effect.gen(function* () {
    log('A. issue(parentId=PROJECT, name=N_A) — the shape the provider uses today')
    yield* issue('A', PROJECT_ID, NAME_A)

    log('B. issue(parentId=SA, name=N_B) — the proto documents the SA as the container')
    yield* issue('B', saId, NAME_B)

    log('C. issue(parentId=PROJECT, name=N_C, labels=alchemy::*) — are ownership labels stored?')
    yield* issue('C', PROJECT_ID, NAME_C, OWNERSHIP_LABELS)

    const byProject = yield* listByName(PROJECT_ID, 'PROJECT')
    const bySa = yield* listByName(saId, 'SA')

    const names = (listed: typeof byProject) => listed.probe.map((k) => k.metadata?.name)
    const seenBy = (name: string) => ({
      project: names(byProject).includes(name),
      serviceAccount: names(bySa).includes(name),
    })
    log('WHICH LIST SEES WHICH KEY', { [NAME_A]: seenBy(NAME_A), [NAME_B]: seenBy(NAME_B) })

    yield* getByName(PROJECT_ID, 'PROJECT', NAME_A)
    yield* getByName(saId, 'SA', NAME_A)
    yield* getByName(PROJECT_ID, 'PROJECT', NAME_B)
    yield* getByName(saId, 'SA', NAME_B)

    // ── The fixed provider's own list path, against the live API ─────────────
    // `Factory.makeTenantScopedList` is exactly what `NebiusStaticKeyProvider.list` is, so this is the
    // acceptance for the fix rather than for the API: the tagged key must come back, and the untagged
    // one must not (nuke deletes every listed target, so a project-scoped list that returns foreign
    // keys would delete credentials this code never created).
    const tenantId =
      process.env.NEBIUS_TENANT_ID ?? (yield* iam.project.get(PROJECT_ID)).metadata?.parentId ?? ''
    log('resolved tenant for the provider-shaped list', { tenantId })
    const asProvider = yield* (providerShapedList().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(IamGrpcModule.IamGrpcService, iam),
          ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_TENANT_ID: tenantId })),
        ),
      ),
      // `makeTenantScopedList` carries a `Context.Service<any, any>` wildcard (see its `oxlint-disable`),
      // so its requirement channel is `any`, and `any` does not unify with the `never` this generator
      // has left after resolving its services — hence the double cast.
    ) as unknown as Effect.Effect<
      ReadonlyArray<{ id: string; name: string; labels?: Record<string, string> }>,
      unknown,
      never
    >)
    const providerProbeKeys = asProvider.filter((r) => r.name.startsWith(PREFIX))
    log('PROVIDER-EQUIVALENT list() (Factory.makeTenantScopedList)', {
      tenantId,
      totalFromAllProjects: asProvider.length,
      probeKeys: providerProbeKeys.map((r) => r.name),
    })
    log('NUKE-SAFETY READING', {
      taggedVisible: providerProbeKeys.some((r) => r.name === NAME_C),
      untaggedWithheld: !providerProbeKeys.some((r) => r.name === NAME_A),
    })

    // ── Verdict: the pair the API honours ────────────────────────────────────
    const a = readings.find((r) => r.arm === 'A')
    const b = readings.find((r) => r.arm === 'B')
    let verdict: string
    if (a === undefined) {
      verdict = 'INCONCLUSIVE — the provider-shaped issue (A: parentId=PROJECT) itself failed.'
    } else {
      const aSeen = a.name === NAME_A ? seenBy(NAME_A) : { project: false, serviceAccount: false }
      const lines = [
        `A stored metadata.parentId = ${a.storedParentId === PROJECT_ID ? 'PROJECT' : a.storedParentId}`,
        `A visible via list(PROJECT) = ${aSeen.project}`,
        `A visible via list(SA) = ${aSeen.serviceAccount}`,
        b === undefined
          ? `B (parentId=SA) was REJECTED — the API does not accept a service account as the issue parent`
          : `B stored metadata.parentId = ${b.storedParentId === saId ? 'SA' : b.storedParentId}` +
            `, visible via list(PROJECT) = ${seenBy(NAME_B).project}, via list(SA) = ${seenBy(NAME_B).serviceAccount}`,
      ]
      verdict =
        aSeen.project && !aSeen.serviceAccount
          ? 'PROJECT IS THE CONTAINER — create(parent=PROJECT) is right and `list` must list by PROJECT ' +
            '(the provider lists per-SA, which is why it cannot see its own keys).'
          : 'UNEXPECTED — read the readings above; the fix must follow whichever parent list() actually honours.'
      log('VERDICT', verdict)
      log('VERDICT EVIDENCE', lines)

      const c = readings.find((r) => r.arm === 'C')
      // Compare order-insensitively: the API echoes the map back in its own key order.
      const sorted = (labels: Record<string, string>) =>
        JSON.stringify(Object.entries(labels).toSorted(([a], [b]) => a.localeCompare(b)))
      log(
        'LABELS READING',
        c === undefined
          ? 'the tagged issue (C) failed — read FAILURES below'
          : sorted(c.labels) === sorted({ ...OWNERSHIP_LABELS })
            ? 'alchemy::* labels are stored and echoed verbatim — a project-scoped list can tell its own keys apart'
            : `labels echoed as ${JSON.stringify(c.labels)} — a project-scoped list CANNOT rely on them`,
      )
    }

    // ── Cascade: is a key deleted with its service account? ──────────────────
    // `static-key.ts` claims "Nebius does not cascade-delete associated resources on SA delete",
    // which is what justifies its `nuke: { dependsOn: [...] }`. Measured here, with A/B still
    // attached (they are deleted in the cleanup below whichever way this goes).
    const deleteError = yield* iam.serviceAccount.delete(saId).pipe(
      Effect.map(() => undefined),
      Effect.catch((error) => Effect.succeed(String(error).slice(0, 200))),
    )
    if (deleteError !== undefined) {
      cascadeReading = `SA delete REFUSED while keys were attached (${deleteError}) — the API enforces the ordering itself`
      log('SA DELETE WITH KEYS ATTACHED', cascadeReading)
    } else {
      yield* Effect.sleep('5 seconds')
      const after = yield* iam.staticKey.list(PROJECT_ID).pipe(
        Effect.catch(() => Effect.succeed([] as StaticKeySchema.StaticKey[])),
      )
      const survivors = after.filter((k) => (k.metadata?.name ?? '').startsWith(PREFIX))
      cascadeReading =
        survivors.length === 0
          ? 'SA delete CASCADED — the keys went with it, so the `does not cascade` comment is wrong'
          : `NO CASCADE — ${survivors.length} key(s) survived the SA delete (they must be deleted explicitly)`
      log('SA DELETE WITH KEYS ATTACHED', cascadeReading)
      log('SURVIVORS', survivors.map((k) => `${k.metadata?.name}@${k.metadata?.parentId}`))
    }

    log('READINGS', readings)
    if (failures.length > 0) log('FAILURES', failures)
  }).pipe(
    // Guaranteed teardown: only the keys this probe named, then the SA — and only if it still exists
    // (the cascade arm above may already have taken it).
    Effect.ensuring(
      Effect.gen(function* () {
        const live = yield* iam.staticKey.list(PROJECT_ID).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log('cleanup — could not list keys by project; delete them by hand', {
                projectId: PROJECT_ID,
                error: String(error).slice(0, 200),
              })
              return [] as StaticKeySchema.StaticKey[]
            }),
          ),
        )
        for (const key of live.filter((k) => (k.metadata?.name ?? '').startsWith(PREFIX))) {
          const id = key.metadata?.id
          if (!id) continue
          yield* iam.staticKey.delete(id).pipe(
            Effect.map(() => log('cleanup — static key deleted', id)),
            Effect.catch((error) =>
              Effect.sync(() => log('cleanup FAILED — delete static key by hand', `${id}: ${String(error).slice(0, 200)}`)),
            ),
          )
        }
        yield* iam.serviceAccount.delete(saId).pipe(
          Effect.map(() => log('cleanup — service account deleted', saId)),
          Effect.catch((error) =>
            Effect.sync(() =>
              log('cleanup — service-account delete did not succeed (may already be gone)', String(error).slice(0, 160)),
            ),
          ),
        )
        yield* Effect.sleep('3 seconds')
        const recheck = yield* iam.staticKey.list(PROJECT_ID).pipe(
          Effect.catch(() => Effect.succeed([] as StaticKeySchema.StaticKey[])),
        )
        const sas = yield* iam.serviceAccount.list(PROJECT_ID).pipe(
          Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ metadata?: { name?: string } | undefined }>)),
        )
        log('POSTFLIGHT', {
          probeKeysLeft: recheck.filter((k) => (k.metadata?.name ?? '').startsWith(PREFIX)).length,
          probeServiceAccountsLeft: sas.filter((sa) => (sa.metadata?.name ?? '').startsWith(PREFIX)).length,
        })
      }),
    ),
  )
})

const credentialsLayer = fromAuthProvider.pipe(Layer.provide(authLayer))
const transportLayer = NebiusGrpcTransportLive.pipe(Layer.provide(credentialsLayer))
const iamLayer = IamGrpcServiceLive.pipe(Layer.provide(transportLayer))
const programLayer = Layer.mergeAll(iamLayer, credentialsLayer, transportLayer)

try {
  await Effect.runPromise(program.pipe(Effect.provide(programLayer), Effect.scoped))
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
