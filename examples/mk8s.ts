/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Managed Kubernetes (mk8s) — Cluster + NodeGroup
 *
 * Creates a working Kubernetes control plane and **one real worker node**:
 *
 *   network → subnet → cluster ─┐
 *   service account + editor grant (group → permit → membership) ─┐
 *                                └────────────────────────────────→ node group
 *
 * The identity chain is not decoration. A node group's
 * `template.serviceAccountId` is what lets the nodes pull images and call the
 * Nebius API, so its service account needs a role on the project — without the
 * grant, nodes join and then fail to image.
 *
 * ⚠️ `fixedNodeCount: 1` provisions a **real, billable VM**, and the node group
 * is the slowest resource here (minutes to `RUNNING`, and the delete waits for
 * the VM). Always `alchemy destroy --yes` when done.
 *
 * `etcdClusterSize: 1` keeps the control plane cheap and **non-HA** — fine for a
 * demo, not for anything you care about (3 is the platform default and the
 * smallest highly-available choice).
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
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  clusterId: Nebius.mk8s.ClusterId
  clusterName: string
  clusterState: string
  /** The version the control plane resolved — omit `version` and read it from here. */
  clusterVersion: string
  nodeGroupId: Nebius.mk8s.NodeGroupId
  nodeGroupName: string
  nodeGroupState: string
  /** The node image actually running, e.g. `v1.36.3-nebius-node.75` (a different format). */
  nodeGroupVersion: string
  /** `fixedNodeCount` as requested, in the JSON rendering's decimal-string form. */
  nodeGroupFixedNodeCount: string
  nodeGroupReadyNodeCount: string
}

export default Alchemy.Stack(
  'ManagedKubernetes',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const projectId = yield* Config.String('NEBIUS_PROJECT_ID')

    const network = yield* Nebius.vpc.Network('Mk8sNetwork')
    const subnet = yield* Nebius.vpc.Subnet('Mk8sSubnet', { networkId: network.id })

    // ── The grant the nodes need ────────────────────────────────────────────
    // `editor` on the project, handed to a throwaway group the SA belongs to.
    // An id from outside a resource output must be branded explicitly:
    // `AccessPermit.resourceId` is polymorphic, so it takes its own brand.
    const serviceAccount = yield* Nebius.iam.ServiceAccount('Mk8sNodes-SA', {
      description: 'nodes of the mk8s example: registry pulls + Nebius API access',
    })
    const grantGroup = yield* Nebius.iam.Group('Mk8sNodes-Group', {})
    yield* Nebius.iam.AccessPermit('Mk8sNodes-Permit', {
      parentId: grantGroup.id,
      resourceId: Nebius.iam.AccessPermitResourceId.make(projectId),
      role: 'editor',
    })
    yield* Nebius.iam.GroupMembership('Mk8sNodes-Membership', {
      parentId: grantGroup.id,
      memberId: serviceAccount.id,
    })

    // ── The control plane ───────────────────────────────────────────────────
    // `subnetId` is create-only (a change plans a replace — an in-place change is
    // answered with an opaque `13 INTERNAL`). `version` is deliberately omitted:
    // the backend picks, and `clusterVersion` below reports what it resolved.
    const cluster = yield* Nebius.mk8s.Cluster('Mk8sCluster', {
      subnetId: subnet.id,
      etcdClusterSize: 1,
    })

    // ── One worker node ─────────────────────────────────────────────────────
    // The parent is the **cluster**, not the project — so `parentId` is required
    // here (there is no `NEBIUS_PROJECT_ID` fallback as there is elsewhere).
    //
    // `fixedNodeCount` and `autoscaling` are mutually exclusive and exactly one is
    // required; switching between them is an in-place update (the API clears the
    // side you left out).
    //
    // `template.os` is not validated against a list — which images exist depends
    // on the Kubernetes version *and* the platform. To see the current pairs:
    //
    //   const matrix = yield* Nebius.mk8s.action.GetNodeGroupCompatibilityMatrix({
    //     clusterKubernetesVersion: '1.36',
    //     platform: 'cpu-d3',
    //   })
    //   // matrix[0].items → [{ os: 'ubuntu24.04', driversPreset: '', … }]
    //
    // The control-plane version catalogue itself is the other action:
    //   const versions = yield* Nebius.mk8s.action.ListClusterControlPlaneVersions()
    const nodeGroup = yield* Nebius.mk8s.NodeGroup('Mk8sNodes', {
      parentId: cluster.id,
      fixedNodeCount: 1,
      template: {
        os: 'ubuntu24.04',
        resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
        // 64 GiB is the platform's boot-disk floor: a smaller disk never reaches
        // cloud-init, so the VM hangs with no diagnostic.
        bootDisk: { sizeGibibytes: 64, type: 'NETWORK_SSD' },
        // Omitted `subnetId` would default to the control plane's subnet; being
        // explicit is clearer, and `publicIpAddress: true` here would make these
        // **public** nodes (reachable and billed).
        networkInterfaces: [{ subnetId: subnet.id }],
        serviceAccountId: serviceAccount.id,
        // Required, and it is the only SSH path into a node. The API accepts a
        // key-less payload (measured), so the key is your responsibility:
        cloudInitUserData: '#cloud-config\npackages:\n  - nginx\n',
        // ── Optional extras, with their costs and caveats ────────────────────
        //
        // Roll-out behaviour (all optional; omit to keep the platform's values,
        // which `status.strategy` reports as effective values):
        //   strategy: { maxUnavailable: { count: 1 }, maxSurge: { percent: 25 }, drainTimeoutSeconds: 600 },
        // Autoscaling instead of a fixed count:
        //   autoscaling: { minNodeCount: 1, maxNodeCount: 3 },
        // Replace a node that stays in a bad condition:
        //   autoRepair: { conditions: [{ type: 'Ready', status: 'FALSE', timeoutSeconds: 300 }] },
        // Kubernetes node labels / the instances' own metadata labels (two maps;
        // neither is rolled out to existing nodes):
        //   metadata: { labels: { 'node-role': 'worker' } },
        //   instanceMetadata: { labels: { team: 'platform' } },
        // Taints (not applied to existing nodes), pods-per-node, preemption,
        // shared filesystems, local disks, capacity reservations:
        //   taints: [{ key: 'dedicated', value: 'demo', effect: 'NO_SCHEDULE' }],
        //   maxPods: 110,
        //   preemptible: true,
        //   filesystems: [{ attachMode: 'READ_WRITE', mountTag: 'data', existingFilesystem: { id: 'computefilesystem-…' } }],
        //   reservationPolicy: { policy: 'STRICT', reservationIds: [Nebius.capacity.CapacityBlockGroupId.make('capacityblockgroup-…')] },
        //
        // GPU nodes need a platform+preset from the compatibility matrix and a
        // driver preset; NVLink (`GB200`/`GB300` racks) requires fixed sizing and
        // non-preemptible nodes, and an existing NVLInstanceGroup:
        //   gpuSettings: { driversPreset: 'cuda12.8' },
        //   gpuCluster: { id: gpuCluster.id },
        //   nvlink: { nvlInstanceGroupId: nvlGroup.id },
      },
    })

    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      clusterState: cluster.state as unknown as string,
      clusterVersion: cluster.version as unknown as string,
      nodeGroupId: nodeGroup.id,
      nodeGroupName: nodeGroup.name,
      nodeGroupState: nodeGroup.state as unknown as string,
      nodeGroupVersion: nodeGroup.version as unknown as string,
      nodeGroupFixedNodeCount: nodeGroup.fixedNodeCount as unknown as string,
      nodeGroupReadyNodeCount: nodeGroup.readyNodeCount as unknown as string,
    }
  }),
)
