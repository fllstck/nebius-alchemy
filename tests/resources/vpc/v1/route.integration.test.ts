import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const { test } = Test.make({ providers: Nebius.providers() as any })

integrationTest(test.provider, 'Nebius.vpc.v1.Route lifecycle', (stack) =>
  Effect.gen(function* () {
    const { network, rt, route } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('RouteTest-Network', {})
        const rt = yield* Nebius.vpc.RouteTable('RouteTest-RouteTable', {
          networkId: network.id,
        })
        const route = yield* Nebius.vpc.Route('RouteTest-Route', {
          parentId: rt.id,
          destination: { cidr: '0.0.0.0/0' },
          nextHop: { defaultEgressGateway: true },
        })
        return { network, rt, route }
      }),
    )

    expect(network.id).toBeDefined()
    expect(rt.id).toBeDefined()
    expect(route.id).toBeDefined()
    expect(typeof route.id).toBe('string')
    expect(route.parentId).toBe(rt.id)
    expect(route.state).toBe('READY')

    // Update: description is mutable, destination is immutable.
    const { route: updated } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('RouteTest-Network', {})
        const rt = yield* Nebius.vpc.RouteTable('RouteTest-RouteTable', {
          networkId: network.id,
        })
        const route = yield* Nebius.vpc.Route('RouteTest-Route', {
          parentId: rt.id,
          destination: { cidr: '0.0.0.0/0' },
          nextHop: { defaultEgressGateway: true },
          description: 'updated',
        })
        return { network, rt, route }
      }),
    )

    expect(updated.id).toBe(route.id)
    expect(updated.description).toBe('updated')
  }).pipe(
    Effect.ensuring(safeDestroy(stack)),
  ),
  { timeout: 180_000 },
)
