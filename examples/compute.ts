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
    const imageFamily = yield* Config.string('IMAGE_FAMILY').pipe(Config.withDefault('ubuntu24.04-driverless'))
    const diskSizeGb = yield* Config.string('DISK_SIZE_GB').pipe(Config.withDefault('10'), Config.map(Number))
    const subnetId = yield* Config.string('SUBNET_ID')
    const serviceAccountId = yield* Config.string('SERVICE_ACCOUNT_ID')

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
      serviceAccountId,
      resources: {
        platform: 'gpu-h200-sxm',
        preset: '1gpu-16vcpu-200gb',
      },
      bootDisk: {
        existingDisk: { id: disk.id },
        attachMode: 'READ_WRITE',
      },
      networkInterfaces: [{ subnetId, name: 'eth0' }],
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
