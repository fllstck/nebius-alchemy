import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'

integrationTest(test.provider, 'Nebius.vpc.v1.RouteTable lifecycle', (stack) =>
  Effect.gen(function* () {
    const { network, rt } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('RTTest-Network', {})
        const rt = yield* Nebius.vpc.RouteTable('RTTest-RouteTable', {
          networkId: network.id,
        })
        return { network, rt }
      }),
    )

    expect(network.id).toBeDefined()
    expect(rt.id).toBeDefined()
    expect(typeof rt.id).toBe('string')
    expect(rt.name).toBeDefined()
    expect(rt.networkId).toBe(network.id)
    expect(rt.state).toBe('READY')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
