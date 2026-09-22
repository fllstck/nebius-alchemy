import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as VpcGrpc from '../../../../modules/api-client/vpc.ts'
import type { RouteTableId } from '../../../../modules/resources/vpc/v1/ids.ts'

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

// ---------------------------------------------------------------------------
// Update path — TASKS.md §"What is left" A.
//
// What the API actually does with `SubnetSpec.routeTableId` (settled live
// 2026-09-22 by this test — the sweep's comment claimed the API echoes the
// ASSIGNED default back into the spec; it does not):
//
//   * omitted from creation → `spec.routeTableId` stays `""`; the route table
//     the subnet really uses is `status.routeTable.{id,default:true}` (the
//     network's default), NOT the spec — `SubnetStatus.routeTable`'s `default`
//     flag is the discriminator;
//   * pinned → `spec.routeTableId` echoes the id and `status.routeTable.default`
//     flips to false. The pin is an in-place `SubnetService/Update`, same id;
//   * UN-pinned again (the prop removed from config) → the guard in the
//     provider's `specDrifted` (`props.routeTableId !== undefined && …`) must
//     write NOTHING. Without it the comparison is a live non-empty id against the
//     omitted prop's `""`, which re-sends an update that drops the user's pin.
//
// Oracle for "no write": `metadata.resourceVersion` (bumped on every accepted
// update), plus the surviving association itself.

/** Network + route table + subnet, with `routeTableId` under test. */
const declareRouteTableSubnet = (routeTableId: RouteTableId | undefined) =>
  Effect.gen(function* () {
    const network = yield* Nebius.vpc.Network('SubnetRt-Network', {})
    const routeTable = yield* Nebius.vpc.RouteTable('SubnetRt-RouteTable', {
      networkId: network.id,
    })
    const subnet = yield* Nebius.vpc.Subnet('SubnetRt-Subnet', {
      networkId: network.id,
      ...(routeTableId === undefined ? {} : { routeTableId }),
    })
    return { routeTable, subnet }
  })

integrationTest(
  test.provider,
  'Nebius.vpc.v1.Subnet — routeTableId: omitted is not drift, pinned converges in place',
  (stack) =>
    Effect.gen(function* () {
      const vpc = yield* VpcGrpc.VpcGrpcService
      const live = (id: string) =>
        vpc.subnet.get(id).pipe(
          Effect.map((raw) => ({
            specRouteTableId: raw.spec!.routeTableId,
            effective: raw.status!.routeTable,
            version: raw.metadata!.resourceVersion.toString(),
            spec: JSON.stringify(raw.spec),
          })),
        )
      const liveNetwork = (id: string) =>
        vpc.network.get(id).pipe(
          Effect.map((raw) => ({
            version: raw.metadata!.resourceVersion.toString(),
            spec: JSON.stringify(raw.spec),
          })),
        )

      // 1. Create WITHOUT pinning a route table: the spec field stays empty and
      //    the network's default lives in `status.routeTable` (default: true).
      const created = yield* stack.deploy(declareRouteTableSubnet(undefined))
      const afterCreate = yield* live(created.subnet.id)
      console.log(
        `PROBE subnet routeTableId: spec="${afterCreate.specRouteTableId}" effective=${JSON.stringify(afterCreate.effective)} version=${afterCreate.version} spec=${afterCreate.spec}`,
      )
      expect(afterCreate.specRouteTableId).toBe('')
      expect(afterCreate.effective?.id).toMatch(/^vpcroutetable-/)
      expect(afterCreate.effective?.default).toBe(true)

      // 1b. Both specs carry the API's materialized pools. For the SUBNET that is a pure echo
      //     (`{pools: [], useNetworkPools: true}`) and `resourceVersion` stays 1: the create
      //     path must not spend a second write. Before the fix it was 2 (create + a spurious
      //     update triggered by comparing the echo against the omitted prop).
      expect(afterCreate.version).toBe('1')

      //     For the NETWORK the platform goes further and assigns real `vpcpool-` ids into the
      //     spec itself, which bumps its version WITHOUT any write of ours (this run logged
      //     zero `Updating Nebius.vpc.v1.Network` notes) — so the version is not an oracle here.
      //     What our reconcile must not do is clobber that assignment: steps 2 and 3 reconcile
      //     the network again (noop) and the assigned ids must survive. (The echo's shape is
      //     `{pools: [{id: vpcpool-…}]}` once the pool ids are assigned; before the assignment
      //     lands it is `{pools: [], useNetworkPools: true}` — either way it is not in `desired`.)
      const networkAfterCreate = yield* liveNetwork(created.subnet.networkId)
      console.log(`PROBE network pools: version=${networkAfterCreate.version} spec=${networkAfterCreate.spec}`)
      expect(networkAfterCreate.spec).toContain('"id":"vpcpool-')

      // 2. Pin a route table of our own — an in-place update, not a replace.
      const pinned = yield* stack.deploy(declareRouteTableSubnet(created.routeTable.id))
      const afterPin = yield* live(created.subnet.id)
      expect(pinned.subnet.id).toBe(created.subnet.id)
      expect(afterPin.specRouteTableId).toBe(created.routeTable.id)
      expect(afterPin.effective?.id).toBe(created.routeTable.id)
      expect(afterPin.effective?.default).toBe(false)
      expect(afterPin.version).not.toBe(afterCreate.version)
      console.log(`PROBE subnet routeTableId: in-place update accepted, version=${afterPin.version} spec=${afterPin.spec}`)

      // 3. Remove the prop from the config — a props change the `diff` ignores,
      //    so the framework plans an update and reconcile runs. It must write
      //    NOTHING: the version must not move, and the user's pin must survive
      //    (neither `spec.routeTableId` nor the effective association resets to
      //    the network default).
      const omitted = yield* stack.deploy(declareRouteTableSubnet(undefined))
      const afterOmit = yield* live(created.subnet.id)
      console.log(`PROBE subnet routeTableId: after omit version=${afterOmit.version} spec=${afterOmit.spec}`)
      expect(omitted.subnet.id).toBe(created.subnet.id)
      expect(afterOmit.specRouteTableId).toBe(created.routeTable.id)
      expect(afterOmit.effective?.default).toBe(false)
      expect(afterOmit.version).toBe(afterPin.version)

      // 3b. The network went through the same two reconciles without its API-assigned pool ids
      //     being clobbered (the unguarded comparison would have re-sent a spec without them).
      const networkAfterOmit = yield* liveNetwork(created.subnet.networkId)
      expect(networkAfterOmit.spec).toBe(networkAfterCreate.spec)
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 300_000 },
)
