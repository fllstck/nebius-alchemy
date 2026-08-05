import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as NetworkModule from '../../../../modules/resources/vpc/v1/network'
import * as NetworkSchema from '../../../../modules/resources/vpc/v1/network.schema'
import * as SubnetModule from '../../../../modules/resources/vpc/v1/subnet'
import * as SubnetSchema from '../../../../modules/resources/vpc/v1/subnet.schema'
import * as SecurityGroupModule from '../../../../modules/resources/vpc/v1/security-group'
import * as SecurityGroupSchema from '../../../../modules/resources/vpc/v1/security-group.schema'
import * as SecurityRuleModule from '../../../../modules/resources/vpc/v1/security-rule'
import * as SecurityRuleSchema from '../../../../modules/resources/vpc/v1/security-rule.schema'
import * as RouteTableModule from '../../../../modules/resources/vpc/v1/route-table'
import * as RouteTableSchema from '../../../../modules/resources/vpc/v1/route-table.schema'
import * as RouteModule from '../../../../modules/resources/vpc/v1/route'
import * as RouteSchema from '../../../../modules/resources/vpc/v1/route.schema'
import * as PoolModule from '../../../../modules/resources/vpc/v1/pool'
import * as PoolSchema from '../../../../modules/resources/vpc/v1/pool.schema'
import * as AllocationModule from '../../../../modules/resources/vpc/v1/allocation'
import * as AllocationSchema from '../../../../modules/resources/vpc/v1/allocation.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'

const { describe, expect, test } = BunTest

describe('Nebius.vpc.v1.Network', () => {
  test('constructor defined', () => { expect(typeof NetworkModule.NebiusNetwork).toBe('function') })
  test('provider defined', () => { expect(NetworkModule.NebiusNetworkProvider).toBeDefined() })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(NetworkModule.NebiusNetwork.Provider, NetworkModule.NebiusNetworkProvider)
      expect(await runDiff(svc, { name: 'new-net' }, { name: 'old-net' })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(NetworkModule.NebiusNetwork.Provider, NetworkModule.NebiusNetworkProvider)
      expect(await runDiff(svc, { name: 'my-net' }, { name: 'my-net' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(NetworkSchema.validateNetworkProps({ name: 'my-network' }))
      expect(result.name).toBe('my-network')
    })
    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(NetworkSchema.validateNetworkProps({ name: 'Bad Net' }).pipe(Effect.flip))
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.vpc.v1.Subnet', () => {
  test('constructor defined', () => { expect(typeof SubnetModule.NebiusSubnet).toBe('function') })
  test('provider defined', () => { expect(SubnetModule.NebiusSubnetProvider).toBeDefined() })

  describe('diff', () => {
    test('networkId change requires replace', async () => {
      const svc = await resolveProvider(SubnetModule.NebiusSubnet.Provider, SubnetModule.NebiusSubnetProvider)
      expect(await runDiff(svc, { networkId: 'network-2' }, { networkId: 'network-1' })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(SubnetModule.NebiusSubnet.Provider, SubnetModule.NebiusSubnetProvider)
      expect(await runDiff(svc, { networkId: 'network-1' }, { networkId: 'network-1' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SubnetSchema.validateSubnetProps({ networkId: 'network-abc123', name: 'my-subnet' }))
      expect(result.networkId).toBe('network-abc123')
    })
    test('rejects props without networkId', async () => {
      const result = await runEffect(SubnetSchema.validateSubnetProps({ name: 'my-subnet' }).pipe(Effect.flip))
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.vpc.v1.SecurityGroup', () => {
  test('constructor defined', () => { expect(typeof SecurityGroupModule.NebiusSecurityGroup).toBe('function') })
  test('provider defined', () => { expect(SecurityGroupModule.NebiusSecurityGroupProvider).toBeDefined() })

  describe('diff', () => {
    test('networkId change requires replace', async () => {
      const svc = await resolveProvider(SecurityGroupModule.NebiusSecurityGroup.Provider, SecurityGroupModule.NebiusSecurityGroupProvider)
      expect(await runDiff(svc, { networkId: 'network-2' }, { networkId: 'network-1' })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(SecurityGroupModule.NebiusSecurityGroup.Provider, SecurityGroupModule.NebiusSecurityGroupProvider)
      expect(await runDiff(svc, { networkId: 'network-1' }, { networkId: 'network-1' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SecurityGroupSchema.validateSecurityGroupProps({ networkId: 'network-abc123' }))
      expect(result.networkId).toBe('network-abc123')
    })
    test('rejects props without networkId', async () => {
      const result = await runEffect(SecurityGroupSchema.validateSecurityGroupProps({}).pipe(Effect.flip))
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.vpc.v1.SecurityRule', () => {
  test('constructor defined', () => { expect(typeof SecurityRuleModule.NebiusSecurityRule).toBe('function') })
  test('provider defined', () => { expect(SecurityRuleModule.NebiusSecurityRuleProvider).toBeDefined() })

  describe('diff', () => {
    test('access change requires replace (immutable)', async () => {
      const svc = await resolveProvider(SecurityRuleModule.NebiusSecurityRule.Provider, SecurityRuleModule.NebiusSecurityRuleProvider)
      expect(await runDiff(svc, { access: 'DENY' }, { access: 'ALLOW' })).toEqual({ action: 'replace' })
    })
    test('ingress sourceCidrs change requires replace', async () => {
      const svc = await resolveProvider(SecurityRuleModule.NebiusSecurityRule.Provider, SecurityRuleModule.NebiusSecurityRuleProvider)
      expect(await runDiff(svc, { ingress: { sourceCidrs: ['10.0.0.0/8'] } }, { ingress: { sourceCidrs: ['192.168.0.0/16'] } })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(SecurityRuleModule.NebiusSecurityRule.Provider, SecurityRuleModule.NebiusSecurityRuleProvider)
      expect(await runDiff(svc, { access: 'ALLOW', ingress: { sourceCidrs: ['10.0.0.0/8'] } }, { access: 'ALLOW', ingress: { sourceCidrs: ['10.0.0.0/8'] } })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SecurityRuleSchema.validateSecurityRuleProps({ parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'ALLOW', priority: 10 }),
      )
      expect(result.access).toBe('ALLOW')
    })
    test('rejects egress spec on an ingress rule', async () => {
      const result = await runEffect(
        SecurityRuleSchema.validateSecurityRuleProps({ parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'ALLOW', egress: {} }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.vpc.v1.RouteTable', () => {
  test('constructor defined', () => { expect(typeof RouteTableModule.NebiusRouteTable).toBe('function') })
  test('provider defined', () => { expect(RouteTableModule.NebiusRouteTableProvider).toBeDefined() })

  describe('diff', () => {
    test('networkId change requires replace', async () => {
      const svc = await resolveProvider(RouteTableModule.NebiusRouteTable.Provider, RouteTableModule.NebiusRouteTableProvider)
      expect(await runDiff(svc, { networkId: 'network-2' }, { networkId: 'network-1' })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(RouteTableModule.NebiusRouteTable.Provider, RouteTableModule.NebiusRouteTableProvider)
      expect(await runDiff(svc, { networkId: 'network-1' }, { networkId: 'network-1' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(RouteTableSchema.validateRouteTableProps({ networkId: 'network-abc123' }))
      expect(result.networkId).toBe('network-abc123')
    })
    test('rejects props without networkId', async () => {
      const result = await runEffect(RouteTableSchema.validateRouteTableProps({}).pipe(Effect.flip))
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.vpc.v1.Route', () => {
  test('constructor defined', () => { expect(typeof RouteModule.NebiusRoute).toBe('function') })
  test('provider defined', () => { expect(RouteModule.NebiusRouteProvider).toBeDefined() })

  describe('diff', () => {
    test('parentId change requires replace', async () => {
      const svc = await resolveProvider(RouteModule.NebiusRoute.Provider, RouteModule.NebiusRouteProvider)
      expect(await runDiff(svc, { parentId: 'routetable-2' }, { parentId: 'routetable-1' })).toEqual({ action: 'replace' })
    })
    test('disabling an enabled defaultEgressGateway requires replace (sticky-true)', async () => {
      const svc = await resolveProvider(RouteModule.NebiusRoute.Provider, RouteModule.NebiusRouteProvider)
      expect(await runDiff(svc, { nextHop: { defaultEgressGateway: false } }, { nextHop: { defaultEgressGateway: true } })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(RouteModule.NebiusRoute.Provider, RouteModule.NebiusRouteProvider)
      expect(await runDiff(svc, { parentId: 'routetable-1', nextHop: { defaultEgressGateway: true } }, { parentId: 'routetable-1', nextHop: { defaultEgressGateway: true } })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        RouteSchema.validateRouteProps({ parentId: 'routetable-abc', destination: { cidr: '10.0.0.0/24' } }),
      )
      expect(result.parentId).toBe('routetable-abc')
    })
    test('rejects an invalid CIDR', async () => {
      const result = await runEffect(
        RouteSchema.validateRouteProps({ parentId: 'routetable-abc', destination: { cidr: '999.0.0.0/99' } }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.vpc.v1.Pool', () => {
  test('constructor defined', () => { expect(typeof PoolModule.NebiusPool).toBe('function') })
  test('provider defined', () => { expect(PoolModule.NebiusPoolProvider).toBeDefined() })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(PoolModule.NebiusPool.Provider, PoolModule.NebiusPoolProvider)
      expect(await runDiff(svc, { name: 'new-pool' }, { name: 'old-pool' })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(PoolModule.NebiusPool.Provider, PoolModule.NebiusPoolProvider)
      expect(await runDiff(svc, { name: 'my-pool' }, { name: 'my-pool' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        PoolSchema.validatePoolProps({ name: 'my-pool', version: 'IPV4', visibility: 'PRIVATE', cidrs: [{ cidr: '10.0.0.0/24' }] }),
      )
      expect(result.version).toBe('IPV4')
    })
    test('rejects an invalid pool CIDR', async () => {
      const result = await runEffect(
        PoolSchema.validatePoolProps({ name: 'my-pool', version: 'IPV4', visibility: 'PRIVATE', cidrs: [{ cidr: 'not-a-cidr' }] }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.vpc.v1.Allocation', () => {
  test('constructor defined', () => { expect(typeof AllocationModule.NebiusAllocation).toBe('function') })
  test('provider defined', () => { expect(AllocationModule.NebiusAllocationProvider).toBeDefined() })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(AllocationModule.NebiusAllocation.Provider, AllocationModule.NebiusAllocationProvider)
      expect(await runDiff(svc, { name: 'new-alloc' }, { name: 'old-alloc' })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(AllocationModule.NebiusAllocation.Provider, AllocationModule.NebiusAllocationProvider)
      expect(await runDiff(svc, { name: 'my-alloc' }, { name: 'my-alloc' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        AllocationSchema.validateAllocationProps({ name: 'my-alloc', ipv4Public: { cidr: '10.0.0.0/24' } }),
      )
      expect(result.name).toBe('my-alloc')
    })
    test('rejects props with neither ipv4Private nor ipv4Public', async () => {
      const result = await runEffect(
        AllocationSchema.validateAllocationProps({ name: 'my-alloc' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
