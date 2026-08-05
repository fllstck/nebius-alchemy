import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(test.provider, 'Nebius.vpc.v1.SecurityGroup lifecycle', (stack) =>
  Effect.gen(function* () {
    const { network, sg } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('SGTest-Network', {})
        const sg = yield* Nebius.vpc.SecurityGroup('SGTest-SG', {
          networkId: network.id,
        })
        return { network, sg }
      }),
    )

    expect(network.id).toBeDefined()
    expect(sg.id).toBeDefined()
    expect(typeof sg.id).toBe('string')
    expect(sg.name).toBeDefined()
    expect(sg.networkId).toBe(network.id)
    expect(sg.state).toBe('READY')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
