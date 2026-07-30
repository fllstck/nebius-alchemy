/**
 * ─────────────────────────────────────────────────────────────────────────────
 * VPC
 *
 * Creates a complete Nebius VPC topology: Network, Subnet, RouteTable, Route,
 * SecurityGroup, SecurityRule, IP Pool, and Allocation.
 *
 * `name` is omitted from all props — auto-generated from logical IDs
 * (`"TestNetwork"`, `"TestSubnet"`, etc.).
 *
 * Several optional props now have defaults:
 * - SecurityRule `type` defaults to `"STATEFUL"` (access and protocol are required)
 * - Pool requires `version` and `visibility`
 *
 * Usage:
 *   alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID     (required)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  networkId: Nebius.vpc.NetworkId
  networkName: string
  networkState: string
  defaultRouteTableId: Nebius.vpc.RouteTableId
  subnetId: Nebius.vpc.SubnetId
  subnetName: string
  subnetState: string
  routeTableId: Nebius.vpc.RouteTableId
  routeTableName: string
  routeTableState: string
  routeId: Nebius.vpc.RouteId
  routeName: string
  routeState: string
  securityGroupId: Nebius.vpc.SecurityGroupId
  securityGroupName: string
  securityGroupState: string
  securityRuleId: Nebius.vpc.SecurityRuleId
  securityRuleName: string
  securityRuleState: string
  poolId: Nebius.vpc.PoolId
  poolName: string
  poolState: string
  poolVersion: string
  poolVisibility: string
  allocationId: Nebius.vpc.AllocationId
  allocationName: string
  allocationState: string
}

export default Alchemy.Stack(
  'VPC',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const network = yield* Nebius.vpc.Network('TestNetwork')

    const subnet = yield* Nebius.vpc.Subnet('TestSubnet', {
      networkId: network.id,
    })

    const routeTable = yield* Nebius.vpc.RouteTable('TestRouteTable', {
      networkId: network.id,
    })

    const route = yield* Nebius.vpc.Route('TestRoute', {
      parentId: routeTable.id,
      destination: { cidr: '0.0.0.0/0' },
      nextHop: { defaultEgressGateway: true },
    })

    const securityGroup = yield* Nebius.vpc.SecurityGroup('TestSecurityGroup', {
      networkId: network.id,
    })

    const securityRule = yield* Nebius.vpc.SecurityRule('TestSecurityRule', {
      parentId: securityGroup.id,
      direction: 'INGRESS',
      protocol: 'TCP',
      access: 'ALLOW',
      priority: 100,
      ingress: { destinationPorts: [80, 443] },
    })

    const pool = yield* Nebius.vpc.Pool('TestPool', {
      version: 'IPV4',
      visibility: 'PRIVATE',
      cidrs: [{ cidr: '10.100.0.0/24' }],
    })

    const allocation = yield* Nebius.vpc.Allocation('TestAllocation', {
      ipv4Private: { poolId: pool.id, cidr: '10.100.0.42/32' },
    })

    return {
      networkId: network.id as unknown as Nebius.vpc.NetworkId,
      networkName: network.name as unknown as string,
      networkState: network.state as unknown as string,
      defaultRouteTableId: network.defaultRouteTableId as unknown as Nebius.vpc.RouteTableId,
      subnetId: subnet.id as unknown as Nebius.vpc.SubnetId,
      subnetName: subnet.name as unknown as string,
      subnetState: subnet.state as unknown as string,
      routeTableId: routeTable.id as unknown as Nebius.vpc.RouteTableId,
      routeTableName: routeTable.name as unknown as string,
      routeTableState: routeTable.state as unknown as string,
      routeId: route.id as unknown as Nebius.vpc.RouteId,
      routeName: route.name as unknown as string,
      routeState: route.state as unknown as string,
      securityGroupId: securityGroup.id as unknown as Nebius.vpc.SecurityGroupId,
      securityGroupName: securityGroup.name as unknown as string,
      securityGroupState: securityGroup.state as unknown as string,
      securityRuleId: securityRule.id as unknown as Nebius.vpc.SecurityRuleId,
      securityRuleName: securityRule.name as unknown as string,
      securityRuleState: securityRule.state as unknown as string,
      poolId: pool.id as unknown as Nebius.vpc.PoolId,
      poolName: pool.name as unknown as string,
      poolState: pool.state as unknown as string,
      poolVersion: pool.version as unknown as string,
      poolVisibility: pool.visibility as unknown as string,
      allocationId: allocation.id as unknown as Nebius.vpc.AllocationId,
      allocationName: allocation.name as unknown as string,
      allocationState: allocation.state as unknown as string,
    }
  }),
)
