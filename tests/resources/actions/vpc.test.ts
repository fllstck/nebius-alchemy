import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../helpers/stack'
import { expect } from 'bun:test'
import * as Validation from '../../../modules/resources/validation'
import { integrationTest } from '../../helpers/gate'
import { safeDestroy } from '../../helpers/cleanup'

// ── VPC Actions ────────────────────────────────────────────────────────────

integrationTest(test.provider, 'Nebius.vpc.action.GetNetwork / ListNetworks', (stack) =>
  Effect.gen(function* () {
    const net = yield* stack.deploy(
      Nebius.vpc.Network('ActionTest-Net', {}),
    )

    const { networks, found } = yield* stack.deploy(
      Effect.gen(function* () {
        const networks = yield* Nebius.vpc.action.ListNetworks({})
        const found = yield* Nebius.vpc.action.GetNetwork({ name: net.name })
        return { networks, found }
      }),
    )

    expect(found?.id).toBe(net.id)
    expect(found?.name).toBe(net.name)
    expect(networks.some((n) => n.id === net.id)).toBe(true)

    // The not-found path is a separate action instance (distinct logical id —
    // same-name actions in one stack share a single output) and fails with
    // ResourceNotFoundError by contract. Effect.flip surfaces the deploy's
    // failure as the success value.
    const notFound = yield* stack
      .deploy(
        Effect.gen(function* () {
          yield* Nebius.vpc.action.GetNetwork('NotFoundCheck', { name: 'nonexistent-network-99999' })
        }),
      )
      .pipe(Effect.flip)
    expect(notFound).toBeInstanceOf(Validation.ResourceNotFoundError)
  }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)

integrationTest(test.provider, 'Nebius.vpc.action.GetSubnet / ListSubnets', (stack) =>
  Effect.gen(function* () {
    // Deploy the whole graph in ONE stack so destroy orders the child
    // (subnet) before the parent (network). Separate deploys replace the
    // entire stack each time — the parent would be scheduled for deletion
    // while the child still exists, and the API rejects it
    // (FAILED_PRECONDITION), orphaning the network.
    const { subnet } = yield* stack.deploy(
      Effect.gen(function* () {
        const net = yield* Nebius.vpc.Network('ActionTest-Sub-Net', {})
        const subnet = yield* Nebius.vpc.Subnet('ActionTest-Sub', { networkId: net.id })
        return { subnet }
      }),
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
  }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)

integrationTest(test.provider, 'Nebius.vpc.action.GetSecurityGroup / ListSecurityGroups', (stack) =>
  Effect.gen(function* () {
    // Single stack — see GetSubnet test for why.
    const { sg } = yield* stack.deploy(
      Effect.gen(function* () {
        const net = yield* Nebius.vpc.Network('ActionTest-SG-Net', {})
        const sg = yield* Nebius.vpc.SecurityGroup('ActionTest-SG', { networkId: net.id })
        return { sg }
      }),
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
  }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)

integrationTest(test.provider, 'Nebius.vpc.action.GetRouteTable / ListRouteTables', (stack) =>
  Effect.gen(function* () {
    // Single stack — see GetSubnet test for why.
    const { rt } = yield* stack.deploy(
      Effect.gen(function* () {
        const net = yield* Nebius.vpc.Network('ActionTest-RT-Net', {})
        const rt = yield* Nebius.vpc.RouteTable('ActionTest-RT', { networkId: net.id })
        return { rt }
      }),
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
  }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)

integrationTest(test.provider, 'Nebius.vpc.action.GetPool / ListPools', (stack) =>
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
  }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)
