/**
 * Does `StaticKeyService.Issue` dedupe on `x-idempotency-key`? (R-01)
 *
 * R-01 is the finding that the retry key is minted **per attempt**: `withGrpcRetry` re-invokes the
 * whole call, and the channel's metadata generator (which minted the key) runs once per RPC attempt,
 * so a `Create`/`Issue` that timed out client-side but succeeded server-side is re-sent with a
 * *different* key. The remedy has two branches (ISSUES.md R-01):
 *
 *   1. mint the key per **logical operation** and thread it through the retry, so the server can
 *      dedupe; or
 *   2. retry only read methods (mutations at `maxRetries: 0`).
 *
 * Branch 1 only works if the server actually *uses* the key. The proto comment and the gosdk's
 * "fresh key per request" are not evidence — this probe measures it.
 *
 * One throwaway `iam/v1` service account, three `Issue` calls with **controlled** keys, then list
 * the keys that exist. The raw client is used (not the wrapped one) because the whole point is to
 * choose the key by hand, and a raw client makes exactly one wire call per attempt:
 *
 *   A. issue(key=K, name=N)   → reference response
 *   B. issue(key=K, name=N)   → the SAME key + the SAME request: deduped?
 *   C. issue(key=K2, name=N)  → a different key, same name: is `name` unique at all?
 *
 * Readings:
 *   B succeeds with the same resourceId as A → the server DEDUPES on the key (branch 1 is enough;
 *     a retry after a client-side timeout is safe).
 *   B fails ALREADY_EXISTS                     → the server ignores the key, and `Issue` enforces
 *     name uniqueness (a retry surfaces an error, but does not double-issue).
 *   B succeeds with a *new* resourceId         → the server ignores the key AND has no name
 *     uniqueness: the retry left TWO live credentials (the failure R-01 describes).
 *   C tells us whether `name` is unique independently of the key.
 *
 *   bun spikes/idempotency-key-probe.ts
 */
import { randomUUID } from 'node:crypto'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import * as grpc from '@grpc/grpc-js'

import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as GrpcUtils from '../modules/api-client/grpc-utils.ts'
import * as IamGrpcModule from '../modules/api-client/iam.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as EndpointsModule from '../modules/endpoints.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as AccessSchema from '../schemas/nebius/iam/v1/access.ts'
import * as StaticKeySchema from '../schemas/nebius/iam/v1/static_key.ts'
import * as StaticKeyServiceSchema from '../schemas/nebius/iam/v1/static_key_service.ts'
import { requireProjectId } from './spike-env.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransport, NebiusGrpcTransportLive } = GrpcTransportModule
const { IamGrpcService, IamGrpcServiceLive } = IamGrpcModule
const { endpointFor } = EndpointsModule
const { NebiusCredentials } = NebiusCredentialsModule

const PROJECT_ID = requireProjectId()
const RUN = new Date().toISOString().replace(/[:.]/g, '-')
const SA_PREFIX = 'alchemy-idem-probe'
const SA_NAME = `${SA_PREFIX}-${RUN}`
const NAME_2 = `${SA_PREFIX}-b-${RUN}`
// UUID-formatted on purpose: the gosdk mints `randomUUID()` keys, so a server that validates the
// header shape would silently ignore a non-UUID and this probe would measure the wrong thing.
const KEY_A = randomUUID()
const KEY_B = randomUUID()
const KEY_C = randomUUID()

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (label: string, value: unknown) =>
  console.log(`[${stamp()}] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

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

/** One controlled-key issue, exactly one wire call (raw client — no retry). */
const issue = (
  client: InstanceType<typeof StaticKeyServiceSchema.StaticKeyServiceClient>,
  serviceAccountId: string,
  idempotencyKey: string,
  name: string,
): Effect.Effect<StaticKeyServiceSchema.IssueStaticKeyResponse, unknown> =>
  Effect.tryPromise({
    try: () =>
      new Promise<StaticKeyServiceSchema.IssueStaticKeyResponse>((resolve, reject) => {
        const metadata = new grpc.Metadata()
        metadata.set('x-idempotency-key', idempotencyKey)
        client.issue(
          StaticKeyServiceSchema.IssueStaticKeyRequest.fromPartial({
            metadata: { parentId: PROJECT_ID, name },
            spec: StaticKeySchema.StaticKeySpec.fromJSON({
              account: AccessSchema.Account.fromPartial({ serviceAccount: { id: serviceAccountId } }),
              service: 'OBSERVABILITY',
            }),
          }),
          metadata,
          (error, response) => (error ? reject(error) : resolve(response)),
        )
      }),
    catch: (cause) => cause,
  })

interface Reading {
  readonly attempt: string
  readonly idempotencyKey: string
  readonly resourceId: string
  readonly token: string
  readonly operationId: string | undefined
}

const program = Effect.gen(function* () {
  const iam = yield* IamGrpcService
  const transport = yield* NebiusGrpcTransport
  const { apiKey } = yield* yield* NebiusCredentials

  // ── Preflight: refuse to run over a leftover probe service account ─────────
  const existing = yield* iam.serviceAccount.list(PROJECT_ID)
  const leftovers = existing.filter((sa) => (sa.metadata?.name ?? '').startsWith(SA_PREFIX))
  if (leftovers.length > 0) {
    log('ABORT — leftover probe service accounts; delete them first', leftovers.map((sa) => sa.metadata?.id))
    return
  }

  // ── The raw client, on a channel whose generator adds ONLY authorization ───
  // The transport's shared channel mints its own `x-idempotency-key` per attempt (that is R-01);
  // the probe has to own the key, so it builds a bare channel with the credential alone.
  const endpoint = yield* endpointFor('nebius.iam.v1.StaticKeyService')
  const authOnly = grpc.credentials.createFromMetadataGenerator((_params, callback) => {
    const metadata = new grpc.Metadata()
    metadata.add('authorization', `Bearer ${Redacted.value(apiKey)}`)
    callback(null, metadata)
  })
  const channel = new grpc.Channel(
    endpoint,
    grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), authOnly),
    {},
  )
  const raw = new StaticKeyServiceSchema.StaticKeyServiceClient('unused', grpc.credentials.createSsl(), {
    channelOverride: channel,
  })

  // ── A throwaway service account to issue against ──────────────────────────
  let createdSa = false
  let saId = ''
  const created = yield* iam.serviceAccount
    .create({ metadata: { parentId: PROJECT_ID, name: SA_NAME }, spec: {} })
    .pipe(
      Effect.map((sa) => sa.metadata!.id),
      Effect.catch((error) =>
        Effect.sync(() => {
          log('service-account create failed — will reuse an existing SA', String(error).slice(0, 200))
          return undefined
        }),
      ),
    )
  if (created !== undefined) {
    saId = created
    createdSa = true
    log('created probe service account', { id: saId, name: SA_NAME })
  } else {
    const fallback = existing[0]
    if (fallback?.metadata?.id === undefined) {
      log('ABORT — no service account available to issue keys against', { count: existing.length })
      return
    }
    saId = fallback.metadata.id
    log('reusing existing service account (only probe-named keys are cleaned up)', {
      id: saId,
      name: fallback.metadata.name,
    })
  }

  const readings: Array<Reading> = []
  const failures: Array<{ attempt: string; idempotencyKey: string; error: string }> = []

  const attempt = (label: string, idempotencyKey: string, name: string) =>
    Effect.gen(function* () {
      const response = yield* issue(raw, saId, idempotencyKey, name).pipe(
        Effect.catch((error) => {
          failures.push({ attempt: label, idempotencyKey, error: String(error).slice(0, 300) })
          return Effect.succeed(undefined)
        }),
      )
      if (response === undefined) {
        log(`${label}: REJECTED`, failures.at(-1)?.error)
        return
      }
      // Issue is long-running; the key only exists once the operation completes.
      const operationId = response.operation?.id
      if (operationId) {
        yield* GrpcUtils.pollOperation(operationId, 'nebius.iam.v1.StaticKeyService', transport)
      }
      const resourceId = response.operation?.resourceId ?? ''
      readings.push({ attempt: label, idempotencyKey, resourceId, token: response.token, operationId })
      log(`${label}: ACCEPTED`, {
        idempotencyKey,
        resourceId,
        tokenLength: response.token.length,
        tokenPrefix: response.token.slice(0, 24),
        operationId,
      })
    })

  yield* Effect.gen(function* () {
    log('A. issue(key=A, name=N) — the reference', { key: KEY_A, name: SA_NAME })
    yield* attempt('A', KEY_A, SA_NAME)

    log('B. issue(key=A, name=N) — SAME key + SAME request (the dedupe question)', { key: KEY_A, name: SA_NAME })
    yield* attempt('B', KEY_A, SA_NAME)

    log('C. issue(key=B, name=N) — different key, same name (is the name unique?)', { key: KEY_B, name: SA_NAME })
    yield* attempt('C', KEY_B, SA_NAME)

    // ── D/E: the ACTUAL timeout shape — a retry while the first operation is in flight ──
    // A/B let A's operation finish before B. A client timeout (DEADLINE_EXCEEDED) fires with the
    // server-side operation possibly still running, so this arm sends the retry *immediately*, with
    // no poll in between. If the server deduped only while an operation was in flight, this is the
    // arm that would show it.
    log('D. issue(key=C, name=M) — reference, NOT polled (operation left in flight)', { key: KEY_C, name: NAME_2 })
    const d = yield* issue(raw, saId, KEY_C, NAME_2).pipe(
      Effect.catch((error) => {
        failures.push({ attempt: 'D', idempotencyKey: KEY_C, error: String(error).slice(0, 300) })
        return Effect.succeed(undefined)
      }),
    )
    if (d !== undefined) {
      readings.push({
        attempt: 'D',
        idempotencyKey: KEY_C,
        resourceId: d.operation?.resourceId ?? '',
        token: d.token,
        operationId: d.operation?.id,
      })
      log('D: ACCEPTED', { idempotencyKey: KEY_C, resourceId: d.operation?.resourceId, operationId: d.operation?.id })
    } else {
      log('D: REJECTED', failures.at(-1)?.error)
    }
    log('E. issue(key=C, name=M) — SAME key, sent immediately (in-flight dedupe?)', { key: KEY_C, name: NAME_2 })
    yield* attempt('E', KEY_C, NAME_2)
    if (d?.operation?.id) {
      yield* GrpcUtils.pollOperation(d.operation.id, 'nebius.iam.v1.StaticKeyService', transport)
    }

    // ── Witness: what actually exists ────────────────────────────────────────
    // Which parent does `list` want? The API answered A with "already exists in project-…", so the
    // real parent is the PROJECT — measured here next to the per-SA form the provider uses.
    const byProject = yield* iam.staticKey.list(PROJECT_ID)
    const bySa = yield* iam.staticKey.list(saId).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          log('list(saId) failed', String(error).slice(0, 200))
          return [] as ReadonlyArray<StaticKeySchema.StaticKey>
        }),
      ),
    )
    const probeKeys = byProject.filter((k) => (k.metadata?.name ?? '').startsWith(SA_PREFIX))
    log('keys live', {
      byProjectParent: byProject.length,
      bySaParent: bySa.length,
      probeNamed: probeKeys.length,
      probeIds: probeKeys.map((k) => k.metadata?.id),
      probeParents: probeKeys.map((k) => k.metadata?.parentId),
    })

    // ── Verdict ─────────────────────────────────────────────────────────────
    const a = readings.find((r) => r.attempt === 'A')
    const b = readings.find((r) => r.attempt === 'B')
    const c = readings.find((r) => r.attempt === 'C')
    let verdict: string
    if (a === undefined) {
      verdict = 'INCONCLUSIVE — the reference issue (A) itself failed.'
    } else if (b === undefined) {
      const alreadyExists = failures.some((f) => f.attempt === 'B' && f.error.includes('ALREADY_EXISTS'))
      verdict = alreadyExists
        ? 'NO DEDUPE, but the NAME is unique (B answered ALREADY_EXISTS) — a retry never double-issues, it just errors.'
        : 'NO DEDUPE — B was rejected for another reason; read the error above.'
    } else if (b.resourceId === a.resourceId && b.token === a.token) {
      verdict =
        'DEDUPE CONFIRMED — the same idempotency key returns the same credential (same resourceId and token). ' +
        'Branch 1 (per-logical-operation key) makes a retried Issue safe.'
    } else if (b.resourceId === a.resourceId) {
      verdict = 'DEDUPE (resourceId matches; token differs — investigate).'
    } else {
      verdict =
        'NO DEDUPE — the same key produced a SECOND live credential (different resourceId). ' +
        'Branch 1 alone is NOT enough: a retried Issue would double-issue. Use branch 2 for mutations.'
    }
    verdict += c === undefined ? '  (C was rejected: the NAME is unique.)' : '  (C was accepted: the NAME is not unique.)'
    log('VERDICT', verdict)

    const e = readings.find((r) => r.attempt === 'E')
    const inFlight =
      d === undefined
        ? 'D itself failed'
        : e === undefined
          ? 'E rejected (ALREADY_EXISTS) — no IN-FLIGHT dedupe either, which is the arm that matches a client timeout'
          : e.resourceId === (d.operation?.resourceId ?? '')
            ? 'E returned the SAME resourceId — IN-FLIGHT dedupe exists'
            : 'E created a SECOND resource — the double-credential case'
    log('IN-FLIGHT READING', inFlight)
  }).pipe(
    // Guaranteed teardown: only the keys this probe named (never an unrelated key that happened to
    // live on a reused SA), then the SA — and only if this probe created it.
    Effect.ensuring(
      Effect.gen(function* () {
        const live = yield* iam.staticKey.list(PROJECT_ID).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log('cleanup — could not list keys by project; delete them by hand', {
                projectId: PROJECT_ID,
                error: String(error).slice(0, 200),
              })
              return [] as ReadonlyArray<StaticKeySchema.StaticKey>
            }),
          ),
        )
        for (const key of live.filter((k) => (k.metadata?.name ?? '').startsWith(SA_PREFIX))) {
          const id = key.metadata?.id
          if (!id) continue
          yield* iam.staticKey.delete(id).pipe(
            Effect.map(() => log('cleanup — static key deleted', id)),
            Effect.catch((error) =>
              Effect.sync(() =>
                log('cleanup FAILED — delete static key by hand', `${id}: ${String(error).slice(0, 200)}`),
              ),
            ),
          )
        }
        if (createdSa) {
          yield* iam.serviceAccount.delete(saId).pipe(
            Effect.map(() => log('cleanup — service account deleted', saId)),
            Effect.catch((error) =>
              Effect.sync(() =>
                log('cleanup FAILED — delete service account by hand', `${saId}: ${String(error).slice(0, 200)}`),
              ),
            ),
          )
        }
        yield* Effect.sleep('3 seconds')
        const remaining = yield* iam.serviceAccount.list(PROJECT_ID).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log('POSTFLIGHT — service-account list failed', String(error).slice(0, 200))
              return [] as ReadonlyArray<{ metadata?: { name?: string } | undefined }>
            }),
          ),
        )
        log('POSTFLIGHT', {
          probeServiceAccounts: remaining.filter((sa) => (sa.metadata?.name ?? '').startsWith(SA_PREFIX)).length,
        })
      }),
    ),
  )
})

// `fromAuthProvider` (→ `NebiusCredentials`) is merged, not just provided: the program reads the
// API key directly to build the probe's own channel.
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
