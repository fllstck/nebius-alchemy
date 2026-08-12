import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'

integrationTest(test.provider, 'Nebius.compute.v1.Instance lifecycle', (stack) =>
  Effect.gen(function* () {
    const { network, subnet, instance } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('InstanceTest-Network', {})
        const subnet = yield* Nebius.vpc.Subnet('InstanceTest-Subnet', {
          networkId: network.id,
        })
        const instance = yield* Nebius.compute.Instance('InstanceTest-Instance', {
          resources: {
            platform: 'cpu-d3',
            preset: '4vcpu-16gb',
          },
          bootDisk: {
            attachMode: 'READ_WRITE',
            managedDisk: {
              name: 'boot-disk',
              spec: {
                sizeGibibytes: 64,
                type: 'NETWORK_SSD',
                sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
              },
            },
          },
          networkInterfaces: [
            {
              name: 'eth0',
              subnetId: subnet.id,
              ipAddress: { allocationId: '' },
            },
          ],
          serviceAccountId: '',
        })
        return { network, subnet, instance }
      }),
    )

    expect(network.id).toBeDefined()
    expect(subnet.id).toBeDefined()
    expect(instance.id).toBeDefined()
    expect(typeof instance.id).toBe('string')
    expect(instance.name).toBeDefined()
    expect(['RUNNING', 'CREATING']).toContain(instance.state)
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 300_000 },
)
