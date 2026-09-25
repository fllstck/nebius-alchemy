/**
 * Read-only probe: does the mk8s Kubernetes API server accept the **plain
 * Nebius IAM access token** as `Authorization: Bearer <token>`?
 *
 * This is the single open question blocking a **CLI-free** `nebius-mk8s`
 * {@link ClusterAdapter} (mirroring `aws-eks`, which mints SigV4 tokens from
 * ambient credentials — no `aws` CLI, no exec plugin). Nebius's equivalent
 * token is already resolved headlessly by `modules/Credentials.ts`
 * (`NebiusCredentials.apiKey`) for every auth method — `env`, `stored`,
 * `oauth`, and `sa-key` all funnel into `{ apiKey: Redacted }`, where `apiKey`
 * is the IAM access token. `nebius mk8s cluster get-token` takes **no cluster
 * id, no audience, no endpoint** (only `--profile`/`--impersonate-…`/`--format`),
 * which strongly implies it is that same token wrapped in `ExecCredential`.
 * This probe confirms it against a live cluster, with no CLI involved.
 *
 * What each outcome means for the adapter's `connect`:
 *   - `/api/v1/namespaces` → 200, or 403 naming a real user: **token accepted**
 *     (auth works; the 403 case just lacks an RBAC binding) → `connect` is a
 *     plain lookup of `NebiusCredentials`, no token exchange, no audience.
 *   - 403 `system:anonymous` (matching the no-token control), or 401: the plain
 *     access token is **not** the right credential → `connect` needs a
 *     `TokenExchangeService.Exchange(…, audience: <k8s-client-id>)` call instead.
 *
 * The JWT `iss`/`aud` dump is the fast path to the same answer without waiting
 * on the request: an `aud` naming the k8s API server (rather than a generic
 * Nebius client) would already tell us the exchange is required.
 *
 *   bun spikes/mk8s-kubeconfig-auth-probe.ts
 *   CLUSTER_ID=mk8scluster-… bun spikes/mk8s-kubeconfig-auth-probe.ts
 *
 * Read-only: lists clusters, `get`s one, and makes GET requests to the API
 * server. Nothing is created, updated, or deleted.
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import * as https from 'node:https'

import * as Mk8sGrpcModule from '../modules/api-client/mk8s.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import { tryPromiseRaw } from '../modules/effect-utils.ts'
import { ClusterStatus_State, type Cluster } from '../schemas/nebius/mk8s/v1/cluster.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { Mk8sGrpcService, Mk8sGrpcServiceLive } = Mk8sGrpcModule

// Values reused from the 2026-09-23 probe session. `CLUSTER_ID` is optional —
// when absent, the first `RUNNING` cluster in the project is used.
const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const CLUSTER_ID = process.env.CLUSTER_ID

// Same auth-layer assembly as `spikes/mk8s-probe.ts`: resolves the ambient
// credential through alchemy's provider-resolution pipeline, exactly as a
// deploy would — so the token we test is the token the adapter would mint.
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

/** Decode a JWT's claims, adding a human-readable expiry for the `exp` claim. */
const decodeJwt = (token: string): Record<string, unknown> | string => {
  const parts = token.split('.')
  if (parts.length !== 3) return `(opaque token, ${token.length} chars — not a JWT)`
  try {
    const claims = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    if (typeof claims.exp === 'number') {
      return {
        ...claims,
        expHuman: new Date(claims.exp * 1000).toISOString(),
        expiresInMin: Math.round((claims.exp - Date.now() / 1000) / 60),
      }
    }
    return claims
  } catch (cause) {
    return `failed to decode JWT payload: ${String(cause)}`
  }
}

/** Normalize an endpoint string (bare `host[:port]` or a full URL) to host + port. */
const normalizeEndpoint = (raw: string): { host: string; port: number } => {
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  return { host: url.hostname, port: url.port ? Number(url.port) : 443 }
}

interface K8sResponse {
  status: number
  body: string
}

/**
 * One GET against the API server. `ca` + `rejectUnauthorized: true` tests
 * whether `clusterCaCertificate` actually verifies the endpoint's TLS chain;
 * `rejectUnauthorized: false` skips TLS so a cert problem can't confound the
 * auth signal.
 */
const k8sGet = (options: {
  host: string
  port: number
  path: string
  token?: string
  ca?: string
  rejectUnauthorized?: boolean
}): Effect.Effect<K8sResponse, unknown> =>
  tryPromiseRaw(
    () =>
      new Promise<K8sResponse>((resolve, reject) => {
        const req = https.request(
          {
            host: options.host,
            port: options.port,
            path: options.path,
            method: 'GET',
            rejectUnauthorized: options.rejectUnauthorized ?? true,
            ...(options.ca !== undefined ? { ca: options.ca } : {}),
            headers: {
              Accept: 'application/json',
              ...(options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {}),
            },
            timeout: 15_000,
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
              body += chunk
            })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
          },
        )
        req.on('timeout', () => req.destroy(new Error(`GET ${options.path} timed out`)))
        req.on('error', (err) => reject(err))
        req.end()
      }),
  )

/** Classify a response against the "is the token recognized?" question. */
const classify = (res: K8sResponse): string => {
  if (res.status === 200) return 'ACCEPTED + AUTHORIZED (200)'
  if (res.status === 401) return 'REJECTED (401) — token not accepted'
  if (res.status === 403) {
    if (res.body.includes('system:anonymous')) {
      return 'NOT RECOGNIZED (403 system:anonymous) — treated as anonymous'
    }
    return 'ACCEPTED but UNAUTHORIZED (403, named identity) — auth works, RBAC denies'
  }
  if (res.status < 0) return `TRANSPORT ERROR (${res.status})`
  return `status ${res.status}`
}

const show = (label: string, value: unknown) =>
  console.log(`\n== ${label} ==\n${JSON.stringify(value, null, 2)?.slice(0, 1400)}`)

/** Resolve a RUNNING cluster (explicit `CLUSTER_ID` wins, else first in project). */
const findCluster = (mk8s: Mk8sGrpcModule.Mk8sGrpcServiceShape): Effect.Effect<Cluster> =>
  Effect.gen(function* () {
    if (CLUSTER_ID) {
      return yield* mk8s.cluster.get(CLUSTER_ID).pipe(
        Effect.catch((e) => Effect.die(`CLUSTER_ID '${CLUSTER_ID}' not found: ${String(e)}`)),
      )
    }
    const clusters = yield* mk8s.cluster.list(PROJECT_ID).pipe(
      Effect.catch((e) => Effect.die(`cluster.list failed: ${String(e)}`)),
    )
    const running = clusters.find((c) => c.status?.state === ClusterStatus_State.RUNNING)
    if (running) return running
    return yield* Effect.die(
      'No RUNNING cluster found — set CLUSTER_ID, or provision one (see spikes/mk8s-write-probe.ts).',
    )
  })

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService
  const { apiKey } = yield* yield* NebiusCredentialsModule.NebiusCredentials
  const token = Redacted.value(apiKey)

  // ── 1. What credential is this, exactly? ────────────────────────────────
  show('JWT claims — is `aud` scoped to the k8s API server, or generic?', decodeJwt(token))

  // ── 2. Find a RUNNING cluster ────────────────────────────────────────────
  const cluster = yield* findCluster(mk8s)

  const statusCp = cluster.status?.controlPlane
  const publicEndpoint = statusCp?.endpoints?.publicEndpoint
  const privateEndpoint = statusCp?.endpoints?.privateEndpoint
  const ca = statusCp?.auth?.clusterCaCertificate
  show('cluster', {
    id: cluster.metadata?.id,
    name: cluster.metadata?.name,
    state: cluster.status ? ClusterStatus_State[cluster.status.state] : undefined,
    publicEndpoint,
    privateEndpoint,
    caBytes: ca?.length,
  })

  const rawEndpoint = publicEndpoint || privateEndpoint
  if (!rawEndpoint) {
    return yield* Effect.die('Cluster has no endpoint in status yet (still provisioning?)')
  }
  const { host, port } = normalizeEndpoint(rawEndpoint)

  // ── 3. Reachability (unauthenticated endpoint) ──────────────────────────
  const version = yield* k8sGet({ host, port, path: '/version', token, rejectUnauthorized: false }).pipe(
    Effect.catch((e) => Effect.succeed({ status: -1, body: String(e) })),
  )
  show('GET /version (token, TLS skipped) — reachability', version)

  // ── 4. THE auth signal ──────────────────────────────────────────────────
  const authed = yield* k8sGet({
    host,
    port,
    path: '/api/v1/namespaces',
    token,
    rejectUnauthorized: false,
  }).pipe(Effect.catch((e) => Effect.succeed({ status: -1, body: String(e) })))
  show(`GET /api/v1/namespaces (token) → ${classify(authed)}`, authed)

  // ── 5. Control: no token — proves the API server rejects anonymous, so a
  //    `system:anonymous` 403 *with* the token means the token was ignored. ──
  const anon = yield* k8sGet({ host, port, path: '/api/v1/namespaces', rejectUnauthorized: false }).pipe(
    Effect.catch((e) => Effect.succeed({ status: -1, body: String(e) })),
  )
  show(`GET /api/v1/namespaces (no token) → ${classify(anon)}`, anon)

  // ── 6. TLS: does clusterCaCertificate verify the endpoint? ──────────────
  //    (secondary signal for the `certificateAuthorityData` we'd ship on the
  //    Connection attribute — PEM here, base64 on the wire.)
  if (ca) {
    const tls = yield* k8sGet({ host, port, path: '/version', token, ca, rejectUnauthorized: true }).pipe(
      Effect.catch((e) => Effect.succeed({ status: -1, body: String(e) })),
    )
    show('GET /version (ca=clusterCaCertificate, TLS verified)', tls)
  }

  // ── 7. Verdict ──────────────────────────────────────────────────────────
  const ok = authed.status === 200 || (authed.status === 403 && !authed.body.includes('system:anonymous'))
  console.log(
    `\n== VERDICT ==\n` +
      (ok
        ? `Token ACCEPTED — a CLI-free 'nebius-mk8s' adapter's connect() is a plain ` +
          `NebiusCredentials lookup (Bearer <apiKey>), no token exchange, no audience.`
        : `Token NOT recognized as-is — connect() needs a TokenExchangeService.Exchange(…, ` +
          `audience: <k8s-client-id>) call before it can ship the bearer token.`),
  )
})

// Compose bottom-up and provide once. `fromAuthProvider` (→ `NebiusCredentials`)
// is built as a separate layer and **merged** into the final layer — unlike
// `Layer.provide` (which hides the provided layer's output), the program also
// needs `NebiusCredentials` directly to read the access token, so it must be
// exposed, not just consumed to build the gRPC transport.
const credentialsLayer = fromAuthProvider.pipe(Layer.provide(authLayer))
const transportLayer = NebiusGrpcTransportLive.pipe(Layer.provide(credentialsLayer))
const mk8sLayer = Mk8sGrpcServiceLive.pipe(Layer.provide(transportLayer))
const programLayer = Layer.mergeAll(mk8sLayer, credentialsLayer)

try {
  await Effect.runPromise(program.pipe(Effect.provide(programLayer), Effect.scoped))
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
