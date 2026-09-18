/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Compute — Image → Disk → Instance
 *
 * Dynamically looks up the latest Ubuntu 22.04 LTS image, creates a
 * NETWORK_SSD disk from it, then launches a preemptible instance with
 * that disk as its boot disk.
 *
 * Usage:
 *   SUBNET_ID=<subnet-id> alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * `name` is omitted from all resources — auto-generated from logical IDs.
 *
 * Environment variables:
 *   NEBIUS_API_KEY           (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID        (required)
 *   SUBNET_ID                (required for Instance)
 *   SERVICE_ACCOUNT_ID       (required for Instance)
 *   IMAGE_FAMILY             (optional)  Default: ubuntu24.04-driverless
 *   DISK_SIZE_GB             (optional)  Default: 10
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  imageId: string
  imageFamily: string
  imageState: string
  diskId: string
  diskName: string
  diskState: string
  diskType: string
  diskSizeGibibytes: number | undefined
  instanceId?: string
  instanceName?: string
  instanceState?: string
}

export default Alchemy.Stack(
  'Compute',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const imageFamily = yield* Config.String('IMAGE_FAMILY').pipe(Config.withDefault('ubuntu24.04-driverless'))
    // Nebius enforces a 64 GiB boot-disk floor (smaller disks hang provisioning).
    const diskSizeGb = yield* Config.String('DISK_SIZE_GB').pipe(Config.withDefault('64'), Config.map(Number))
    const subnetId = yield* Config.String('SUBNET_ID')
    const serviceAccountId = yield* Config.String('SERVICE_ACCOUNT_ID')

    // Dynamically find the latest public image by family name
    const image = yield* Nebius.compute.Image('UbuntuImage', {
      imageFamily,
    })

    // `type` is required — NETWORK_SSD for boot disks
    const disk = yield* Nebius.compute.Disk('TestDisk', {
      type: 'NETWORK_SSD',
      sizeGibibytes: diskSizeGb,
      sourceImageId: image.id,
    })

    // Create a preemptible instance with the disk as boot disk
    const instance = yield* Nebius.compute.Instance('TestInstance', {
      // IDs read from the environment are branded at the boundary.
      serviceAccountId: Nebius.iam.ServiceAccountId.make(serviceAccountId),
      resources: {
        platform: 'gpu-h200-sxm',
        preset: '1gpu-16vcpu-200gb',
      },
      bootDisk: {
        existingDisk: { id: disk.id },
        attachMode: 'READ_WRITE',
      },
      networkInterfaces: [
        { subnetId: Nebius.vpc.SubnetId.make(subnetId), name: 'eth0', ipAddress: { allocationId: '' } },
      ],
      preemptible: { onPreemption: 'STOP' },
    })

    return {
      imageId: image.id,
      imageFamily: image.imageFamily ?? '',
      imageState: image.state,
      diskId: disk.id,
      diskName: disk.name,
      diskState: disk.state,
      diskType: disk.type,
      diskSizeGibibytes: disk.sizeGibibytes,
      instanceId: instance.id,
      instanceName: instance.name,
      instanceState: instance.state,
    }
  }),
)

// ---------------------------------------------------------------------------
// GPU clusters and NVLink instance groups
// ---------------------------------------------------------------------------
//
// Not wired into the stack above, because both need something the environment
// may not have — a **physical InfiniBand fabric** for `GpuCluster` and a
// GB200/GB300 entitlement for `NVLInstanceGroup`. Discover a fabric with the
// read-only capacity action, then copy this into the stack's Effect:
//
//   const rows = yield* Nebius.capacity.action.ListResourceAdvice({ region: 'eu-north1' })
//   const fabric = rows[0]!.fabric      // e.g. 'fabric-7'
//
//   // The group first — its `id` is what the members reference.
//   const cluster = yield* Nebius.compute.GpuCluster('Cluster', {
//     infinibandFabric: fabric,
//   })
//
//   const group = yield* Nebius.compute.NVLInstanceGroup('Rack', {
//     type: 'GB200',
//     size: 2,                    // maximum members; adjustable in place
//   })
//
//   // Membership is declared HERE, on the instance — never on the group.
//   // Alchemy sees the Output reference and orders the deploy (group before
//   // member) and the destroy (member before group) accordingly.
//   const node = yield* Nebius.compute.Instance('NodeA', {
//     serviceAccountId: Nebius.iam.ServiceAccountId.make(serviceAccountId),
//     resources: { platform: 'gpu-h200-sxm', preset: '1gpu-16vcpu-200gb' },
//     bootDisk: { /* … */ },
//     networkInterfaces: [
//       { subnetId: Nebius.vpc.SubnetId.make(subnetId), name: 'eth0', ipAddress: { allocationId: '' } },
//     ],
//     gpuCluster: { id: cluster.id },        // create-only: changing it replaces the VM
//     nvlInstanceGroupId: group.id,          // changeable in place (moves the VM out of the group)
//   })
//
// Deleting the group while members remain is refused with `GpuClusterNotEmpty` /
// `NVLInstanceGroupNotEmpty` naming them — which also catches the case where a
// *replace* of the group (pinned `name`) would have to delete it before its
// members are recreated.
