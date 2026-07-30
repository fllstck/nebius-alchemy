import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.compute.v1.Instance lifecycle', (stack) =>
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
                sizeGibibytes: 10,
                type: 'NETWORK_SSD',
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
    Effect.ensuring(stack.destroy().pipe(Effect.ignore)),
  ),
  { timeout: 300_000 },
)
