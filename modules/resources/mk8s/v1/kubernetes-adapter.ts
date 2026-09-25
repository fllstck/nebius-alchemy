/**
 * The `nebius-mk8s` {@link ClusterAdapter}: everything platform-specific about
 * running the cluster-agnostic `Kubernetes.*` workloads on a Nebius Managed
 * Kubernetes (`mk8s`) cluster.
 *
 * - **connect** — a plain IAM access token (`Authorization: Bearer <token>`)
 *   against the cluster endpoint, re-describing the cluster when the
 *   connection doesn't carry endpoint/CA (or they've gone stale).
 *
 * This is the **CLI-free** mirror of `aws-eks`: the token is resolved from
 * `NebiusCredentials` (the same ambient credential every Nebius gRPC call
 * uses), so no `nebius` binary, no exec credential plugin, and no
 * audience-scoped token exchange are involved. That the plain access token is
 * accepted is **measured**, not assumed: `spikes/mk8s-auth-probe-cluster.ts`
 * (2026-09-25) created a 1-etcd cluster and got `200` from
 * `GET /api/v1/namespaces` with the token, while the no-token control got
 * `403 system:anonymous` — and `clusterCaCertificate` verified the endpoint's
 * TLS chain.
 *
 * The adapter is auth-only, like the built-in kinds: no workload identity and
 * no managed image registry. Workloads bind through environment variables and
 * run pre-built `image` references (or `Manifest`/`HelmChart`); `main` and
 * `context` image sources need a registry adapter (a follow-up).
 *
 * Registered by `Nebius.providers()`; resolved dynamically by the
 * `Kubernetes.*` providers via the connection's `auth.kind`.
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import {
  ClusterAdapter,
  ClusterNotFoundError,
  type ClusterAdapterService,
  type ClusterTransport,
} from 'alchemy/Kubernetes/ClusterAdapter'
import type { Connection } from 'alchemy/Kubernetes/Connection'

import * as Mk8sGrpc from '../../../api-client/mk8s.ts'
import * as NebiusCredentialsModule from '../../../Credentials.ts'
import * as Ids from './ids.ts'
import { ClusterNotReadyError } from './cluster.schema.ts'
import { ClusterStatus_State } from '../../../../schemas/nebius/mk8s/v1/cluster.ts'

declare module 'alchemy/Kubernetes/Connection' {
  interface AuthRegistry {
    /**
     * Authenticate against a Nebius mk8s cluster with the ambient IAM access
     * token. Contributed by `Nebius.providers()` — `Nebius.mk8s.Cluster`
     * attributes expose a ready-made `connection` carrying this descriptor.
     */
    'nebius-mk8s': {
      /** The mk8s cluster id — re-described via `ClusterService.Get` when the connection omits endpoint/CA. */
      clusterId: Ids.ClusterId
    }
  }
}

/**
 * The `Connection` shape `Nebius.mk8s.Cluster` attributes expose. It is a
 * narrowed view of alchemy's `Connection` (auth fixed to `nebius-mk8s`), so it
 * is assignable to the general `Connection` a `Kubernetes.*` workload accepts
 * — that is what lets the whole cluster resource be passed as `cluster`.
 */
export interface Mk8sConnection {
  endpoint?: string
  certificateAuthorityData?: string
  insecureSkipTlsVerify?: boolean
  auth: { kind: 'nebius-mk8s'; clusterId: Ids.ClusterId }
}

/**
 * Build the {@link Mk8sConnection} of an mk8s cluster, stamped on
 * `Nebius.mk8s.Cluster` attributes. `endpoint`/`certificateAuthorityData` are
 * optional — the adapter re-describes them from the live cluster when absent.
 *
 * ⚠️ `certificateAuthorityData` is **base64** (alchemy's `Connection` contract);
 * the mk8s API hands back PEM (`clusterCaCertificate`), so the caller encodes.
 */
export const mk8sConnectionOf = (options: {
  clusterId: string
  endpoint?: string
  certificateAuthorityData?: string
}): Mk8sConnection => ({
  endpoint: options.endpoint,
  certificateAuthorityData: options.certificateAuthorityData,
  // Brand at the boundary: the caller's id is a plain string (e.g. `metadata.id`).
  auth: { kind: 'nebius-mk8s', clusterId: Ids.ClusterId.make(options.clusterId) },
})

/**
 * Require both halves of a cluster transport, or fail with the tagged {@link ClusterNotReadyError}.
 *
 * Extracted so that outcome has a **declared, tagged channel of its own** instead of being erased into
 * the `Error` leg of alchemy's `ClusterAdapterService.connect` contract
 * (`ClusterNotFoundError | Error`) — which is what let a plain `Error` stand in for a state a caller is
 * supposed to tell apart from “gone” (R-07).
 */
export const requireClusterTransport = (
  clusterId: Ids.ClusterId,
  described: { readonly endpoint?: string; readonly certificateAuthorityData?: string },
): Effect.Effect<
  { readonly endpoint: string; readonly certificateAuthorityData: string },
  ClusterNotReadyError
> =>
  described.endpoint && described.certificateAuthorityData
    ? Effect.succeed({ endpoint: described.endpoint, certificateAuthorityData: described.certificateAuthorityData })
    : Effect.fail(
        new ClusterNotReadyError({
          clusterId,
          message: `mk8s cluster '${clusterId}' has no endpoint or certificate authority yet (still creating?)`,
        }),
      )

/**
 * Narrow the connection's auth to this adapter's kind.
 *
 * The `die` is deliberate, and the only one left in this file: `Connection.auth` is a closed union and
 * this adapter is only ever handed connections it built itself (`mk8sConnectionOf`), so a different kind
 * means the adapter registry wired the wrong adapter — a programmer error, not a runtime outcome. Every
 * *runtime* failure here is a tagged error (R-09).
 */
const narrowMk8sAuth = (connection: Connection) =>
  connection.auth.kind === 'nebius-mk8s'
    ? Effect.succeed(connection.auth)
    : Effect.die(new Error(`nebius-mk8s adapter received auth kind '${connection.auth.kind}'`))

/** Services the adapter's methods need, captured at layer build (mirrors EKS). */
type Mk8sAdapterDeps = Mk8sGrpc.Mk8sGrpcService | NebiusCredentialsModule.NebiusCredentials

/**
 * The `nebius-mk8s` cluster adapter layer. Provided (merged) by
 * `Nebius.providers()` so the `Kubernetes.*` workload providers can resolve it
 * from the ambient stack context.
 *
 * The layer captures `Mk8sGrpcService` + `NebiusCredentials` at build time (so
 * its requirement is explicit on the layer, and `Nebius.providers()` feeds it
 * from the gRPC/credential merges). `connect` is then self-contained: it
 * resolves the ambient IAM access token once per call — a 12-hour cached token,
 * stable for the lifetime of a deploy — and reuses it per request.
 */
export const Mk8sKubernetesAdapter = (): Layer.Layer<ClusterAdapterService, never, Mk8sAdapterDeps> =>
  Layer.effect(
    ClusterAdapter('nebius-mk8s'),
    Effect.gen(function* () {
      // Capture the ambient services at layer build so `connect`'s effect
      // carries no requirements — the same `Effect.context` seam EKS uses.
      const context = yield* Effect.context<Mk8sAdapterDeps>()

      /** Describe the cluster; NOT_FOUND / DELETING → ClusterNotFoundError. */
      const describeLiveCluster = Effect.fn('Nebius.mk8s.ClusterAdapter.describeLiveCluster')(
        function* (auth: { clusterId: string }) {
          const mk8s = yield* Mk8sGrpc.Mk8sGrpcService
          const cluster = yield* mk8s.cluster.get(auth.clusterId).pipe(
            Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))),
          )
          if (!cluster || cluster.status?.state === ClusterStatus_State.DELETING) {
            return yield* Effect.fail(
              new ClusterNotFoundError({ message: `mk8s cluster '${auth.clusterId}' no longer exists` }),
            )
          }
          const statusCp = cluster.status?.controlPlane
          // Public endpoint preferred (the control plane is reachable from the
          // internet); private only when no public one was requested.
          const endpoint = statusCp?.endpoints?.publicEndpoint || statusCp?.endpoints?.privateEndpoint
          const pem = statusCp?.auth?.clusterCaCertificate
          return {
            endpoint: endpoint || undefined,
            // The wire hands back PEM; `Connection.certificateAuthorityData` is base64.
            certificateAuthorityData: pem ? Buffer.from(pem).toString('base64') : undefined,
          }
        },
      )

      const connect = Effect.fn('Nebius.mk8s.ClusterAdapter.connect')(function* (connection: Connection) {
        const auth = yield* narrowMk8sAuth(connection)
        // Resolve the ambient IAM access token — the same credential every
        // Nebius gRPC call uses, regardless of auth method (env/stored/oauth/sa-key).
        const { apiKey } = yield* yield* NebiusCredentialsModule.NebiusCredentials

        let endpoint = connection.endpoint
        let certificateAuthorityData = connection.certificateAuthorityData
        if (!endpoint || !certificateAuthorityData) {
          // Re-describe for a fresh endpoint + CA (persisted attributes may
          // predate them, or the cluster was created without a public endpoint
          // and the attributes never carried one).
          const described = yield* describeLiveCluster(auth)
          endpoint = described.endpoint
          certificateAuthorityData = described.certificateAuthorityData
        }

        // Both halves must be present by now — checked here rather than inside the branch above, so the
        // tagged `ClusterNotReadyError` also covers a connection that carried an incomplete pair (R-07).
        const transport = yield* requireClusterTransport(auth.clusterId, { endpoint, certificateAuthorityData })

        return {
          endpoint: transport.endpoint,
          certificateAuthorityData: transport.certificateAuthorityData,
          headers: Effect.succeed({ Authorization: `Bearer ${Redacted.value(apiKey)}` }),
        } satisfies ClusterTransport
      })

      return {
        kind: 'Kubernetes.ClusterAdapter' as const,
        // Discharge the layer-captured services so `connect` matches the
        // `ClusterAdapterService` contract (requirements = never).
        connect: (connection: Connection) => connect(connection).pipe(Effect.provideContext(context)),
      } satisfies ClusterAdapterService
    }),
  )
