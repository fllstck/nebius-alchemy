import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const { test } = Test.make({ providers: Nebius.providers() as any })

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
    Effect.ensuring(safeDestroy(stack)),
  ),
  { timeout: 120_000 },
)
