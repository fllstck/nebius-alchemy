/**
 * Provision a **minimal throwaway mk8s cluster** to settle the one open
 * question for the CLI-free `nebius-mk8s` Kubernetes adapter: does the API
 * server accept the **plain IAM access token** (what `NebiusCredentials`
 * resolves, no `nebius` CLI, no exec plugin, no audience exchange) as
 * `Authorization: Bearer <token>`?
 *
 * Why a cluster is needed at all: the token is **opaque, not a JWT**
 * (`spikes/mk8s-kubeconfig-auth-probe.ts` measured 302–305 chars), so the
 * `aud`/`iss`-claim shortcut is moot — the live HTTP check is the only oracle.
 * The API server's authenticator either introspects opaque tokens against
 * Nebius IAM (webhook auth → `connect` is a plain `NebiusCredentials` lookup)
 * or does local OIDC/JWT validation (→ `connect` needs a
 * `TokenExchangeService.Exchange` with the right `requestedTokenType`/`audience`).
 *
 * The cluster is the cheapest shape that still has a live API server: one etcd,
 * a public endpoint, **no node group** (workers aren't needed to test auth —
 * the control plane answers `/api`/`/api/v1/namespaces` once RUNNING).
 * Cleanup is guaranteed by `Effect.ensuring`: the cluster is deleted whether
 * the body succeeds or fails.
 *
 *   bun spikes/mk8s-auth-probe-cluster.ts
 *   SUBNET_ID=vpcsubnet-… bun spikes/mk8s-auth-probe-cluster.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import Long from 'long'
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
import { ClusterStatus_State } from '../schemas/nebius/mk8s/v1/cluster.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { Mk8sGrpcService, Mk8sGrpcServiceLive } = Mk8sGrpcModule

// The pre-existing default subnet (same one spikes/mk8s-write-probe.ts used,
// verified 2026-09-23). Override via env if it ever moves.
const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const SUBNET_ID = process.env.SUBNET_ID ?? 'vpcsubnet-e00rf5t1vkbq0ew96x'

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

const log = (label: string, value: unknown) =>
  console.log(`\n== ${label} ==\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)?.slice(0, 1600)}`)

/** Normalize an endpoint string (bare `host[:port]` or a full URL) to host + port. */
const normalizeEndpoint = (raw: string): { host: string; port: number } => {
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  return { host: url.hostname, port: url.port ? Number(url.port) : 443 }
}

interface K8sResponse {
  status: number
  body: string
}

/** One GET against the API server (TLS skippable / CA-verifiable). */
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

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService
  const { apiKey } = yield* yield* NebiusCredentialsModule.NebiusCredentials
  const token = Redacted.value(apiKey)
  log('token', `${token.length} chars (opaque — see the read-only probe for the JWT check)`)

  // ── Create the minimal cluster (1 etcd, public endpoint, no node group) ──
  const name = `alchemy-mk8s-auth-${Date.now()}`
  log('creating minimal cluster', { name, etcdClusterSize: 1, publicEndpoint: true, subnetId: SUBNET_ID })

  const cluster = yield* mk8s.cluster.create({
    metadata: { parentId: PROJECT_ID, name },
    spec: {
      controlPlane: {
        subnetId: SUBNET_ID,
        etcdClusterSize: Long.fromNumber(1),
        // Presence of the (empty) message creates the public endpoint; an empty
        // `allowedCidrs` means unrestricted — exactly what this probe wants.
        endpoints: { publicEndpoint: {} },
      },
    },
  })
  const clusterId = cluster.metadata!.id
  log('cluster created (create polls to operation completion)', {
    id: clusterId,
    state: cluster.status?.state,
  })

  yield* Effect.gen(function* () {
    // Re-read: the create response may predate the endpoint materialization.
    const fresh = yield* mk8s.cluster.get(clusterId)
    const statusCp = fresh.status?.controlPlane
    const publicEndpoint = statusCp?.endpoints?.publicEndpoint
    const privateEndpoint = statusCp?.endpoints?.privateEndpoint
    const ca = statusCp?.auth?.clusterCaCertificate
    log('cluster status', {
      state: fresh.status ? ClusterStatus_State[fresh.status.state] : undefined,
      publicEndpoint,
      privateEndpoint,
      caBytes: ca?.length,
    })

    const rawEndpoint = publicEndpoint || privateEndpoint
    if (!rawEndpoint) {
      return yield* Effect.die('Cluster has no endpoint in status (still provisioning?)')
    }
    const { host, port } = normalizeEndpoint(rawEndpoint)

    // ── 1. Reachability (unauthenticated endpoint) ─────────────────────────
    const version = yield* k8sGet({ host, port, path: '/version', token, rejectUnauthorized: false }).pipe(
      Effect.catch((e) => Effect.succeed({ status: -1, body: String(e) })),
    )
    log('GET /version (token, TLS skipped) — reachability', version)

    // ── 2. THE auth signal ─────────────────────────────────────────────────
    const authed = yield* k8sGet({
      host,
      port,
      path: '/api/v1/namespaces',
      token,
      rejectUnauthorized: false,
    }).pipe(Effect.catch((e) => Effect.succeed({ status: -1, body: String(e) })))
    log(`GET /api/v1/namespaces (token) → ${classify(authed)}`, authed)

    // ── 3. Control: no token → the anonymous baseline ──────────────────────
    const anon = yield* k8sGet({ host, port, path: '/api/v1/namespaces', rejectUnauthorized: false }).pipe(
      Effect.catch((e) => Effect.succeed({ status: -1, body: String(e) })),
    )
    log(`GET /api/v1/namespaces (no token) → ${classify(anon)}`, anon)

    // ── 4. TLS: does clusterCaCertificate verify the endpoint? ─────────────
    if (ca) {
      const tls = yield* k8sGet({ host, port, path: '/version', token, ca, rejectUnauthorized: true }).pipe(
        Effect.catch((e) => Effect.succeed({ status: -1, body: String(e) })),
      )
      log('GET /version (ca=clusterCaCertificate, TLS verified)', tls)
    }

    // ── 5. Verdict ─────────────────────────────────────────────────────────
    const accepted =
      authed.status === 200 || (authed.status === 403 && !authed.body.includes('system:anonymous'))
    log(
      'VERDICT',
      accepted
        ? `Token ACCEPTED — the adapter's connect() is a plain NebiusCredentials lookup ` +
          `(Bearer <apiKey>), no token exchange, no audience, no CLI.`
        : `Token NOT recognized as-is — connect() needs a TokenExchangeService.Exchange ` +
          `(requestedTokenType/audience to be discovered) before shipping the bearer token.`,
    )
  }).pipe(
    // Guaranteed teardown, whatever the body did.
    Effect.ensuring(
      mk8s.cluster
        .delete(clusterId)
        .pipe(
          Effect.map(() => log('cleanup — cluster deleted', clusterId)),
          Effect.catch((e) => Effect.sync(() => log('cleanup FAILED — delete by hand', `${clusterId}: ${String(e)}`))),
        ),
    ),
  )
})

// `fromAuthProvider` (→ `NebiusCredentials`) is merged, not just provided: the
// program reads the token directly, so the credential must be exposed too.
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
