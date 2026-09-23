import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as Mk8sGrpc from '../../../../modules/api-client/mk8s.ts'
import * as Ids from '../../../../modules/resources/iam/v1/ids.ts'
import * as ComputeIds from '../../../../modules/resources/compute/v1/ids.ts'

// ── Integration: the NVLink / GPU arm, gated on an entitlement this tenant lacks ──
//
// ⚠️ **Skipped unless the ids are provided.** A real NVLink node group needs the `GB200`/`GB300`
// entitlement *and* an existing Compute `NVLInstanceGroup` to point at; neither exists here (measured
// 2026-09-23: the entitlement is absent, and `nvlink` can only be *refused* — see
// `spikes/mk8s-nvlink-probe.ts`). So the arm's own coverage is mock-level, and this test documents what
// would have to be true to run it:
//
//   NEBIUS_NVL_INSTANCE_GROUP_ID=computenvlinstancegroup-…   (a real group, in this project)
//   NEBIUS_NVL_PLATFORM=gb300  NEBIUS_NVL_PRESET=gb300-1gpu-32vcpu-200gb
//
// The `GB300`-class preconditions the props enforce (fixed sizing, not preemptible) are unit-tested; the
// two they cannot express (driverfull image, no MIG/NUMA) are documented at `template.gpuSettings`.
//
// What this test *would* establish, which no mock can: that the round trip through the real API keeps
// `nvlink` in `spec.template` — i.e. that our `desiredSpec` mapping and the pinned comparison agree with
// the service's own shape. A *change* to another NVLink group is deliberately not exercised: it needs a
// second group, and the field is measured to be accepted rather than immutable.

const NVL_GROUP_ID = process.env.NEBIUS_NVL_INSTANCE_GROUP_ID
const NVL_PLATFORM = process.env.NEBIUS_NVL_PLATFORM
const NVL_PRESET = process.env.NEBIUS_NVL_PRESET
/** A driverfull image is one of the GB300 preconditions; the compatibility matrix is the authority. */
const NVL_DRIVERS_PRESET = process.env.NEBIUS_NVL_DRIVERS_PRESET ?? 'cuda12.8'

integrationTest(
  test.provider,
  'Nebius.mk8s.v1.NodeGroup NVLink arm (needs an NVLInstanceGroup + entitlement)',
  (stack) =>
    Effect.gen(function* () {
      const mk8s = yield* Mk8sGrpc.Mk8sGrpcService
      const projectId = yield* Config.String('NEBIUS_PROJECT_ID')

      const declare = (labels?: Record<string, string>) =>
        Effect.gen(function* () {
          const network = yield* Nebius.vpc.Network('Mk8sNvl-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('Mk8sNvl-Subnet', { networkId: network.id })
          const sa = yield* Nebius.iam.ServiceAccount('Mk8sNvl-SA', { description: 'mk8s nvlink test' })
          const group = yield* Nebius.iam.Group('Mk8sNvl-Group', {})
          yield* Nebius.iam.AccessPermit('Mk8sNvl-Permit', {
            parentId: group.id,
            resourceId: Ids.AccessPermitResourceId.make(projectId),
            role: 'editor',
          })
          yield* Nebius.iam.GroupMembership('Mk8sNvl-Membership', { parentId: group.id, memberId: sa.id })

          const cluster = yield* Nebius.mk8s.Cluster('Mk8sNvl-Cluster', {
            subnetId: subnet.id,
            etcdClusterSize: 1,
          })
          const nodeGroup = yield* Nebius.mk8s.NodeGroup('Mk8sNvl-NodeGroup', {
            parentId: cluster.id,
            // The props reject autoscaling and preemptible here — the GB300 preconditions.
            fixedNodeCount: 1,
            template: {
              os: process.env.NEBIUS_NVL_OS ?? 'ubuntu24.04',
              resources: { platform: NVL_PLATFORM!, preset: NVL_PRESET! },
              bootDisk: { sizeGibibytes: 64, type: 'NETWORK_SSD' },
              networkInterfaces: [{ subnetId: subnet.id }],
              serviceAccountId: sa.id,
              cloudInitUserData: '#cloud-config\n',
              gpuSettings: { driversPreset: NVL_DRIVERS_PRESET },
              // An env-read id is a plain string, so it is branded explicitly at this boundary — the
              // brand is what keeps a mistyped reference from type-checking (AGENTS.md §"Branded IDs").
              nvlink: { nvlInstanceGroupId: ComputeIds.NVLInstanceGroupId.make(NVL_GROUP_ID!) },
            },
            ...(labels === undefined ? {} : { labels }),
          })
          return { nodeGroup }
        })

      const { nodeGroup } = yield* stack.deploy(declare())
      expect(nodeGroup.state).toBe('RUNNING')

      // The round trip: the API's spec echo must still name the NVLink group we sent.
      const created = yield* mk8s.nodeGroup.get(nodeGroup.id)
      expect(created.spec?.template?.nvlink?.nvlInstanceGroupId).toBe(NVL_GROUP_ID)
      expect(created.spec?.template?.gpuSettings?.driversPreset).toBe(NVL_DRIVERS_PRESET)
      expect(created.metadata?.resourceVersion?.toString()).toBe('1')

      console.log(
        `PROBE mk8s nvlink node group: id=${nodeGroup.id} state=${nodeGroup.state} ` +
          `nvlink=${created.spec?.template?.nvlink?.nvlInstanceGroupId} ` +
          `resourceVersion=${created.metadata?.resourceVersion?.toString()}`,
      )

      // The forced reconcile, as in the CPU test: a create-time-only `labels` change must not write.
      const redeployed = yield* stack.deploy(declare({ 'alchemy-test': 'forced-reconcile' }))
      const afterReconcile = yield* mk8s.nodeGroup.get(redeployed.nodeGroup.id)
      expect(
        afterReconcile.metadata?.resourceVersion?.toString(),
        'reconcile re-wrote the NVLink node group — a drift-list entry is comparing an omitted prop ' +
          'against the API echo',
      ).toBe('1')
      expect(afterReconcile.metadata?.id).toBe(nodeGroup.id)
    }).pipe(safeDestroy(stack)),
  // A GPU node group is the slowest thing here: cluster + nodes + a roll-out-capable delete.
  { timeout: 2_400_000 },
  NVL_GROUP_ID !== undefined && NVL_PLATFORM !== undefined && NVL_PRESET !== undefined,
)
