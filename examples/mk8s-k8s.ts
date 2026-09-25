/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Managed Kubernetes + Alchemy's Kubernetes workloads — the CLI-free bridge.
 *
 * Creates the same cluster + node group as `examples/mk8s.ts`, then applies
 * Alchemy's cluster-agnostic `Kubernetes.*` workloads **directly onto the
 * Nebius cluster**:
 *
 *   network → subnet → cluster (public endpoint) ─┬─→ Kubernetes.Manifest
 *   service account + editor grant ───────────────┤
 *   cluster → node group (one worker) ────────────┴─→ Kubernetes.Deployment
 *
 * The bridge is the cluster's `connection` attribute: a `nebius-mk8s` auth
 * descriptor resolved by `Nebius.providers()` from the **ambient IAM access
 * token** — no `nebius` CLI, no kubeconfig, no exec credential plugin. That the
 * plain access token authenticates against the mk8s API server is measured
 * (`spikes/mk8s-auth-probe-cluster.ts`, 2026-09-25: `200` on
 * `/api/v1/namespaces` with the token, `403 system:anonymous` without).
 *
 * Two things to know:
 *
 * - **`publicEndpoint: {}` is required**, not cosmetic. The workloads are applied
 *   from the machine running `alchemy deploy`, which is *outside* the VPC — so
 *   it reaches the API server over the public endpoint (the private one is
 *   VPC-only). An empty allow-list means unrestricted.
 * - **Only pre-built images today.** The `nebius-mk8s` adapter is auth-only: no
 *   managed registry, so `Deployment`/`Job` run a pre-built `image` reference
 *   (here `nginx:1.27`, pulled from Docker Hub by the nodes). Inline `main` and
 *   Dockerfile `context` sources need a registry adapter — a follow-up.
 *
 * ⚠️ `fixedNodeCount: 1` provisions a **real, billable VM**. Always
 * `alchemy destroy --yes` when done.
 *
 * Usage:
 *   alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID     (required — the cluster's parent, and the grant target)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Layer from 'effect/Layer'
import * as Output from 'alchemy/Output'
import * as Kubernetes from 'alchemy/Kubernetes'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  clusterId: Nebius.mk8s.ClusterId
  /** The endpoint the workloads were applied over (public, since the host is outside the VPC). */
  clusterEndpoint: string | undefined
  nodeGroupId: Nebius.mk8s.NodeGroupId
  /** Kubernetes Deployment name + the image it runs (pre-built — see header). */
  deploymentName: string
  deploymentImage: string
  /** The applied ConfigMap's name + kind (raw-manifest path). */
  manifestName: string
  manifestKind: string
}

export default Alchemy.Stack(
  'Mk8sKubernetes',
  {
    // The cluster-agnostic workload providers join the Nebius providers; the
    // `nebius-mk8s` adapter registered by `Nebius.providers()` is what resolves
    // the cluster's connection at apply time.
    providers: Layer.mergeAll(Nebius.providers(), Kubernetes.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const projectId = yield* Config.String('NEBIUS_PROJECT_ID')

    const network = yield* Nebius.vpc.Network('Mk8sK8sNetwork')
    const subnet = yield* Nebius.vpc.Subnet('Mk8sK8sSubnet', { networkId: network.id })

    // ── The grant the nodes need ────────────────────────────────────────────
    // `editor` on the project, handed to a throwaway group the SA belongs to —
    // the same identity chain as examples/mk8s.ts (registry pulls + API access).
    const serviceAccount = yield* Nebius.iam.ServiceAccount('Mk8sK8s-SA', {
      description: 'nodes of the mk8s-k8s example',
    })
    const grantGroup = yield* Nebius.iam.Group('Mk8sK8s-Group', {})
    yield* Nebius.iam.AccessPermit('Mk8sK8s-Permit', {
      parentId: grantGroup.id,
      resourceId: Nebius.iam.AccessPermitResourceId.make(projectId),
      role: 'editor',
    })
    yield* Nebius.iam.GroupMembership('Mk8sK8s-Membership', {
      parentId: grantGroup.id,
      memberId: serviceAccount.id,
    })

    // ── The control plane (public endpoint — see header) ───────────────────
    const cluster = yield* Nebius.mk8s.Cluster('Mk8sK8sCluster', {
      subnetId: subnet.id,
      etcdClusterSize: 1,
      // Presence is the switch; `{}` (no CIDRs) = unrestricted access.
      publicEndpoint: {},
    })

    // ── One worker, so the Deployment has somewhere to schedule ────────────
    const nodeGroup = yield* Nebius.mk8s.NodeGroup('Mk8sK8sNodes', {
      parentId: cluster.id,
      fixedNodeCount: 1,
      template: {
        os: 'ubuntu24.04',
        resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
        bootDisk: { sizeGibibytes: 64, type: 'NETWORK_SSD' },
        networkInterfaces: [{ subnetId: subnet.id }],
        serviceAccountId: serviceAccount.id,
        cloudInitUserData: '#cloud-config\n',
      },
    })

    // ── The bridge: pass the whole cluster resource as `cluster` ────────────
    // `cluster.connection` carries the `nebius-mk8s` descriptor; auth is the
    // ambient IAM access token. No CLI, no kubeconfig.

    // A raw manifest — any kind, applied via server-side apply. This is the
    // cheapest thing to apply (no image, no node needed).
    const welcome = yield* Kubernetes.Manifest('Welcome', {
      cluster,
      manifest: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'welcome', namespace: 'default' },
        data: { hello: 'from alchemy' },
      },
    })

    // A pre-built image. `ClusterIP` keeps the Service in-cluster (no external
    // load balancer — `LoadBalancer` depends on the platform's LB controller,
    // which the auth-only adapter does not configure). `main`/Dockerfile
    // sources need the registry adapter (see header).
    const web = yield* Kubernetes.Deployment('Web', {
      cluster,
      image: 'nginx:1.27',
      port: 80,
      serviceType: 'ClusterIP',
      replicas: 1,
    })

    return {
      clusterId: cluster.id,
      clusterEndpoint: Output.map(cluster.endpoints, (endpoints) => endpoints?.publicEndpoint),
      nodeGroupId: nodeGroup.id,
      deploymentName: web.deploymentName,
      deploymentImage: web.imageUri,
      manifestName: welcome.name,
      manifestKind: welcome.kind,
    }
  }),
)
