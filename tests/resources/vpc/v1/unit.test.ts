import * as BunTest from 'bun:test'
import * as NetworkModule from '../../../../modules/resources/vpc/v1/network'
import * as SubnetModule from '../../../../modules/resources/vpc/v1/subnet'
import * as SecurityGroupModule from '../../../../modules/resources/vpc/v1/security-group'
import * as SecurityRuleModule from '../../../../modules/resources/vpc/v1/security-rule'
import * as RouteTableModule from '../../../../modules/resources/vpc/v1/route-table'
import * as RouteModule from '../../../../modules/resources/vpc/v1/route'
import * as PoolModule from '../../../../modules/resources/vpc/v1/pool'
import * as AllocationModule from '../../../../modules/resources/vpc/v1/allocation'

const { describe, expect, test } = BunTest

describe('Nebius.vpc.v1.Network', () => {
  test('constructor defined', () => { expect(typeof NetworkModule.NebiusNetwork).toBe('function') })
  test('provider defined', () => { expect(NetworkModule.NebiusNetworkProvider).toBeDefined() })
})

describe('Nebius.vpc.v1.Subnet', () => {
  test('constructor defined', () => { expect(typeof SubnetModule.NebiusSubnet).toBe('function') })
  test('provider defined', () => { expect(SubnetModule.NebiusSubnetProvider).toBeDefined() })
})

describe('Nebius.vpc.v1.SecurityGroup', () => {
  test('constructor defined', () => { expect(typeof SecurityGroupModule.NebiusSecurityGroup).toBe('function') })
  test('provider defined', () => { expect(SecurityGroupModule.NebiusSecurityGroupProvider).toBeDefined() })
})

describe('Nebius.vpc.v1.SecurityRule', () => {
  test('constructor defined', () => { expect(typeof SecurityRuleModule.NebiusSecurityRule).toBe('function') })
  test('provider defined', () => { expect(SecurityRuleModule.NebiusSecurityRuleProvider).toBeDefined() })
})

describe('Nebius.vpc.v1.RouteTable', () => {
  test('constructor defined', () => { expect(typeof RouteTableModule.NebiusRouteTable).toBe('function') })
  test('provider defined', () => { expect(RouteTableModule.NebiusRouteTableProvider).toBeDefined() })
})

describe('Nebius.vpc.v1.Route', () => {
  test('constructor defined', () => { expect(typeof RouteModule.NebiusRoute).toBe('function') })
  test('provider defined', () => { expect(RouteModule.NebiusRouteProvider).toBeDefined() })
})

describe('Nebius.vpc.v1.Pool', () => {
  test('constructor defined', () => { expect(typeof PoolModule.NebiusPool).toBe('function') })
  test('provider defined', () => { expect(PoolModule.NebiusPoolProvider).toBeDefined() })
})

describe('Nebius.vpc.v1.Allocation', () => {
  test('constructor defined', () => { expect(typeof AllocationModule.NebiusAllocation).toBe('function') })
  test('provider defined', () => { expect(AllocationModule.NebiusAllocationProvider).toBeDefined() })
})
