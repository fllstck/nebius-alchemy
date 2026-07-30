import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

// ── VPC Actions ────────────────────────────────────────────────────────────

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.vpc.action.GetNetwork / ListNetworks', (stack) =>
  Effect.gen(function* () {
    const net = yield* stack.deploy(
      Nebius.vpc.Network('ActionTest-Net', {}),
    )

    const { networks, found, notFound } = yield* stack.deploy(
      Effect.gen(function* () {
        const networks = yield* Nebius.vpc.action.ListNetworks({})
        const found = yield* Nebius.vpc.action.GetNetwork({ name: net.name })
        const notFound = yield* Nebius.vpc.action.GetNetwork({ name: 'nonexistent-network-99999' })
        return { networks, found, notFound }
      }),
    )

    expect(found?.id).toBe(net.id)
    expect(found?.name).toBe(net.name)
    expect(networks.some((n) => n.id === net.id)).toBe(true)
    expect(notFound).toBeUndefined()
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
)

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.vpc.action.GetSubnet / ListSubnets', (stack) =>
  Effect.gen(function* () {
    const net = yield* stack.deploy(Nebius.vpc.Network('ActionTest-Sub-Net', {}))
    const subnet = yield* stack.deploy(
      Nebius.vpc.Subnet('ActionTest-Sub', { networkId: net.id }),
    )

    const { subnets, found } = yield* stack.deploy(
      Effect.gen(function* () {
        const subnets = yield* Nebius.vpc.action.ListSubnets({})
        const found = yield* Nebius.vpc.action.GetSubnet({ name: subnet.name })
        return { subnets, found }
      }),
    )

    expect(found?.id).toBe(subnet.id)
    expect(subnets.some((s) => s.id === subnet.id)).toBe(true)
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
)

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.vpc.action.GetSecurityGroup / ListSecurityGroups', (stack) =>
  Effect.gen(function* () {
    const net = yield* stack.deploy(Nebius.vpc.Network('ActionTest-SG-Net', {}))
    const sg = yield* stack.deploy(
      Nebius.vpc.SecurityGroup('ActionTest-SG', { networkId: net.id }),
    )

    const { groups, found } = yield* stack.deploy(
      Effect.gen(function* () {
        const groups = yield* Nebius.vpc.action.ListSecurityGroups({})
        const found = yield* Nebius.vpc.action.GetSecurityGroup({ name: sg.name })
        return { groups, found }
      }),
    )

    expect(found?.id).toBe(sg.id)
    expect(groups.some((g) => g.id === sg.id)).toBe(true)
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
)

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.vpc.action.GetRouteTable / ListRouteTables', (stack) =>
  Effect.gen(function* () {
    const net = yield* stack.deploy(Nebius.vpc.Network('ActionTest-RT-Net', {}))
    const rt = yield* stack.deploy(
      Nebius.vpc.RouteTable('ActionTest-RT', { networkId: net.id }),
    )

    const { tables, found } = yield* stack.deploy(
      Effect.gen(function* () {
        const tables = yield* Nebius.vpc.action.ListRouteTables({})
        const found = yield* Nebius.vpc.action.GetRouteTable({ name: rt.name })
        return { tables, found }
      }),
    )

    expect(found?.id).toBe(rt.id)
    expect(tables.some((t) => t.id === rt.id)).toBe(true)
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
)

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.vpc.action.GetPool / ListPools', (stack) =>
  Effect.gen(function* () {
    const pool = yield* stack.deploy(
      Nebius.vpc.Pool('ActionTest-Pool', {
        version: 'IPV4',
        visibility: 'PRIVATE',
        cidrs: [{ cidr: '10.200.0.0/24' }],
      }),
    )

    const { pools, found } = yield* stack.deploy(
      Effect.gen(function* () {
        const pools = yield* Nebius.vpc.action.ListPools({})
        const found = yield* Nebius.vpc.action.GetPool({ name: pool.name })
        return { pools, found }
      }),
    )

    expect(found?.id).toBe(pool.id)
    expect(pools.some((p) => p.id === pool.id)).toBe(true)
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
)
