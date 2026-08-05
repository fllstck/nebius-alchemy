import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(test.provider, 'Nebius.vpc.v1.Subnet lifecycle', (stack) =>
  Effect.gen(function* () {
    const { network, subnet } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('SubnetTest-Network', {})
        const subnet = yield* Nebius.vpc.Subnet('SubnetTest-Subnet', {
          networkId: network.id,
        })
        return { network, subnet }
      }),
    )

    expect(network.id).toBeDefined()
    expect(network.state).toBe('READY')
    expect(subnet.id).toBeDefined()
    expect(typeof subnet.id).toBe('string')
    expect(subnet.name).toBeDefined()
    expect(subnet.networkId).toBe(network.id)
    expect(subnet.state).toBe('READY')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 180_000 },
)
