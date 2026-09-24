/**
 * Live verification for the `stopped` semantics (2026-09-24).
 *
 * Two runs of the same stack, driven by `PROBE_STOPPED`:
 *
 *   1. `PROBE_STOPPED=1 bun alchemy deploy …` → the VM is created **STOPPED** (`stopped: true` is the only
 *      transmittable value; `false` is a plan-time error now).
 *   2. `bun alchemy deploy …` (prop omitted) → the provider must call the service's **`Start`** RPC and end
 *      up `RUNNING`, *without* reporting drift on every later reconcile.
 *
 * Before the fix this second deploy wrote an update that could never converge (`stopped: false` is encoded
 * as absent = "leave unchanged") and left the VM stopped while waiting for `RUNNING`.
 *
 *   PROBE_STOPPED=1 bun alchemy deploy spikes/instance-stopped-probe.ts --yes
 *   bun alchemy deploy spikes/instance-stopped-probe.ts --yes
 *   bun alchemy destroy spikes/instance-stopped-probe.ts --yes
 */
import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  instanceId: Nebius.compute.InstanceId
  state: string
}

export default Alchemy.Stack(
  'InstanceStoppedProbe',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const subnetId = yield* Config.String('SUBNET_ID')
    const serviceAccountId = yield* Config.String('NEBIUS_SA_ID')
    // The only difference between the two runs: whether the prop is pinned at all.
    const stopped = process.env.PROBE_STOPPED === '1'

    const instance = yield* Nebius.compute.Instance('ProbeVm', {
      serviceAccountId: Nebius.iam.ServiceAccountId.make(serviceAccountId),
      resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
      bootDisk: {
        attachMode: 'READ_WRITE',
        managedDisk: {
          name: 'stopped-probe-boot',
          spec: {
            type: 'NETWORK_SSD',
            sizeGibibytes: 64,
            sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
          },
        },
      },
      networkInterfaces: [
        { subnetId: Nebius.vpc.SubnetId.make(subnetId), name: 'eth0', ipAddress: { allocationId: '' } },
      ],
      ...(stopped ? { stopped: true } : {}),
    })

    return { instanceId: instance.id, state: instance.state }
  }),
)
