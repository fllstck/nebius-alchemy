import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as NetworkModule from '../../../../modules/resources/vpc/v1/network.ts'
import * as NetworkSchema from '../../../../modules/resources/vpc/v1/network.schema.ts'
import * as SubnetModule from '../../../../modules/resources/vpc/v1/subnet.ts'
import * as SubnetSchema from '../../../../modules/resources/vpc/v1/subnet.schema.ts'
import * as SecurityGroupModule from '../../../../modules/resources/vpc/v1/security-group.ts'
import * as SecurityGroupSchema from '../../../../modules/resources/vpc/v1/security-group.schema.ts'
import * as SecurityRuleModule from '../../../../modules/resources/vpc/v1/security-rule.ts'
import * as SecurityRuleSchema from '../../../../modules/resources/vpc/v1/security-rule.schema.ts'
import * as NebiusSecurityRuleProto from '../../../../schemas/nebius/vpc/v1/security_rule.ts'
import * as RouteTableModule from '../../../../modules/resources/vpc/v1/route-table.ts'
import * as RouteTableSchema from '../../../../modules/resources/vpc/v1/route-table.schema.ts'
import * as RouteModule from '../../../../modules/resources/vpc/v1/route.ts'
import * as RouteSchema from '../../../../modules/resources/vpc/v1/route.schema.ts'
import * as PoolModule from '../../../../modules/resources/vpc/v1/pool.ts'
import * as PoolSchema from '../../../../modules/resources/vpc/v1/pool.schema.ts'
import * as AllocationModule from '../../../../modules/resources/vpc/v1/allocation.ts'
import * as AllocationSchema from '../../../../modules/resources/vpc/v1/allocation.schema.ts'
import { resolveProvider, runDiff, runEffect, runReconcile } from '../../../helpers/provider.ts'
import {
  instanceIdLayer,
  mockVpcLayer,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from '../../../helpers/mocks.ts'

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
      expect(await runDiff(svc, { parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'DENY' }, { parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'ALLOW' })).toEqual({ action: 'replace' })
    })
    test('ingress sourceCidrs change requires replace', async () => {
      const svc = await resolveProvider(SecurityRuleModule.NebiusSecurityRule.Provider, SecurityRuleModule.NebiusSecurityRuleProvider)
      expect(await runDiff(svc, { parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'ALLOW', ingress: { sourceCidrs: ['10.0.0.0/8'] } }, { parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'ALLOW', ingress: { sourceCidrs: ['192.168.0.0/16'] } })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(SecurityRuleModule.NebiusSecurityRule.Provider, SecurityRuleModule.NebiusSecurityRuleProvider)
      expect(await runDiff(svc, { parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'ALLOW', ingress: { sourceCidrs: ['10.0.0.0/8'] } }, { parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'ALLOW', ingress: { sourceCidrs: ['10.0.0.0/8'] } })).toBeUndefined()
    })

    // `direction` is NOT a `SecurityRuleSpec` field — the API derives it from which
    // match block is present (`ingress` ⇒ INGRESS, `egress` ⇒ EGRESS) and reports it
    // back in `status.direction`. So the realistic direction change is swapping one
    // match block for the other, and that has to converge. It does: the
    // `sourceCidrs` comparison plans a replace. (Pinned because a props-vs-module
    // text audit flags `direction` as "never compared" — it is compared, on the wire,
    // as the match block it selects.)
    test('flipping direction by swapping the match block requires replace', async () => {
      const svc = await resolveProvider(SecurityRuleModule.NebiusSecurityRule.Provider, SecurityRuleModule.NebiusSecurityRuleProvider)
      expect(
        await runDiff(
          svc,
          { parentId: 'securitygroup-abc', direction: 'EGRESS', protocol: 'TCP', access: 'ALLOW', egress: { destinationCidrs: ['0.0.0.0/0'] } },
          { parentId: 'securitygroup-abc', direction: 'INGRESS', protocol: 'TCP', access: 'ALLOW', ingress: { sourceCidrs: ['10.0.0.0/8'] } },
        ),
      ).toEqual({ action: 'replace' })
    })
  })

  describe('direction is status-derived, not a wire field', () => {
    test('SecurityRuleSpec silently drops `direction` — it is not part of the spec', () => {
      // ts-proto types `fromJSON` as `(object: any)`, so this literal is accepted and the
      // unknown key is dropped — which is exactly the point of the test.
      const spec = NebiusSecurityRuleProto.SecurityRuleSpec.fromJSON({
        direction: 'EGRESS',
        protocol: 'TCP',
        access: 'ALLOW',
        egress: { destinationCidrs: ['0.0.0.0/0'] },
      })

      expect(Object.keys(spec)).not.toContain('direction')
      expect(spec.egress?.destinationCidrs).toEqual(['0.0.0.0/0'])
    })

    test('SecurityRuleStatus carries the platform-computed direction', () => {
      const status = NebiusSecurityRuleProto.SecurityRuleStatus.fromJSON({ direction: 'INGRESS', state: 'READY' })
      expect(status.direction).toBe(NebiusSecurityRuleProto.RuleDirection.INGRESS)
    })
  })

  describe('reconcile (direction convergence)', () => {
    /** A rule as the API models it: no `direction`, only the match block it selects. */
    const liveRule = (matchBlock: Record<string, unknown>, direction: 'INGRESS' | 'EGRESS'): NebiusSecurityRuleProto.SecurityRule => ({
      metadata: protoMetadata('securityrule-1', 'rule-1', 'securitygroup-abc'),
      spec: NebiusSecurityRuleProto.SecurityRuleSpec.fromJSON({
        access: 'ALLOW',
        protocol: 'TCP',
        priority: 500,
        type: 'STATEFUL',
        ...matchBlock,
      }),
      status: {
        state: NebiusSecurityRuleProto.SecurityRuleStatus_State.READY,
        effectivePriority: 500,
        direction: NebiusSecurityRuleProto.RuleDirection[direction],
        source: undefined,
        destination: undefined,
      },
    })

    const layerFor = (
      live: NebiusSecurityRuleProto.SecurityRule,
      updated: Array<{ spec?: NebiusSecurityRuleProto.SecurityRuleSpec }>,
    ) =>
      Effect.provide(
        Layer.mergeAll(
          mockVpcLayer({
            securityRule: {
              get: () => Effect.succeed(live),
              update: (req: { spec?: NebiusSecurityRuleProto.SecurityRuleSpec }) => {
                updated.push(req)
                return Effect.succeed(live)
              },
            },
          }),
          stackLayer,
          testConfigLayer,
          instanceIdLayer,
        ),
      )

    test('swapping the match block converges: the update carries egress and drops ingress', async () => {
      const svc = await resolveProvider(SecurityRuleModule.NebiusSecurityRule.Provider, SecurityRuleModule.NebiusSecurityRuleProvider)
      const updated: Array<{ spec?: NebiusSecurityRuleProto.SecurityRuleSpec }> = []

      await runReconcile(
        svc,
        { parentId: 'securitygroup-abc', direction: 'EGRESS', protocol: 'TCP', access: 'ALLOW', egress: { destinationCidrs: ['0.0.0.0/0'] } },
        { id: 'securityrule-1' },
        undefined,
        layerFor(liveRule({ ingress: { sourceCidrs: ['10.0.0.0/8'] } }, 'INGRESS'), updated),
      )

      expect(updated).toHaveLength(1)
      expect(updated[0]!.spec!.egress?.destinationCidrs).toEqual(['0.0.0.0/0'])
      expect(updated[0]!.spec!.ingress).toBeUndefined()
    })

    test('a match-less rule has no wire change to make, so nothing is written', async () => {
      // With neither `ingress` nor `egress` the spec is identical whatever the
      // `direction` prop says — the API has nothing to derive a direction from, and
      // the attributes report the platform's view (`status.direction`), not the prop.
      const svc = await resolveProvider(SecurityRuleModule.NebiusSecurityRule.Provider, SecurityRuleModule.NebiusSecurityRuleProvider)
      const updated: Array<{ spec?: NebiusSecurityRuleProto.SecurityRuleSpec }> = []

      const attrs = await runReconcile(
        svc,
        { parentId: 'securitygroup-abc', direction: 'EGRESS', protocol: 'TCP', access: 'ALLOW' },
        { id: 'securityrule-1' },
        undefined,
        layerFor(liveRule({}, 'INGRESS'), updated),
      )

      expect(updated).toHaveLength(0)
      expect(attrs.direction).toBe('INGRESS')
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

  describe('spec defaults (no spurious drift-update)', () => {
    test('platform defaults applied when absent', () => {
      expect(
        SecurityRuleModule.withRuleSpecDefaults({
          parentId: 'securitygroup-abc',
          direction: 'INGRESS',
          protocol: 'TCP',
          access: 'ALLOW',
          ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
        } as unknown as SecurityRuleSchema.SecurityRuleProps),
      ).toMatchObject({ priority: 500, type: 'STATEFUL' })
    })
    test('explicit values preserved', () => {
      expect(
        SecurityRuleModule.withRuleSpecDefaults({
          parentId: 'securitygroup-abc',
          direction: 'INGRESS',
          protocol: 'TCP',
          access: 'ALLOW',
          priority: 10,
          type: 'STATELESS',
        } as unknown as SecurityRuleSchema.SecurityRuleProps),
      ).toMatchObject({ priority: 10, type: 'STATELESS' })
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
      expect(await runDiff(svc, { parentId: 'routetable-2', destination: { cidr: '10.0.0.0/24' } }, { parentId: 'routetable-1', destination: { cidr: '10.0.0.0/24' } })).toEqual({ action: 'replace' })
    })
    test('disabling an enabled defaultEgressGateway requires replace (sticky-true)', async () => {
      const svc = await resolveProvider(RouteModule.NebiusRoute.Provider, RouteModule.NebiusRouteProvider)
      expect(await runDiff(svc, { parentId: 'routetable-abc', destination: { cidr: '10.0.0.0/24' }, nextHop: { defaultEgressGateway: false } }, { parentId: 'routetable-abc', destination: { cidr: '10.0.0.0/24' }, nextHop: { defaultEgressGateway: true } })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(RouteModule.NebiusRoute.Provider, RouteModule.NebiusRouteProvider)
      expect(await runDiff(svc, { parentId: 'routetable-1', destination: { cidr: '10.0.0.0/24' }, nextHop: { defaultEgressGateway: true } }, { parentId: 'routetable-1', destination: { cidr: '10.0.0.0/24' }, nextHop: { defaultEgressGateway: true } })).toBeUndefined()
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
      expect(await runDiff(svc, { name: 'new-pool', version: 'IPV4', visibility: 'PRIVATE', cidrs: [{ cidr: '10.0.0.0/24' }] }, { name: 'old-pool', version: 'IPV4', visibility: 'PRIVATE', cidrs: [{ cidr: '10.0.0.0/24' }] })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(PoolModule.NebiusPool.Provider, PoolModule.NebiusPoolProvider)
      expect(await runDiff(svc, { name: 'my-pool', version: 'IPV4', visibility: 'PRIVATE', cidrs: [{ cidr: '10.0.0.0/24' }] }, { name: 'my-pool', version: 'IPV4', visibility: 'PRIVATE', cidrs: [{ cidr: '10.0.0.0/24' }] })).toBeUndefined()
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
      expect(await runDiff(svc, { name: 'new-alloc', ipv4Public: { cidr: '10.0.0.0/24' } }, { name: 'old-alloc', ipv4Public: { cidr: '10.0.0.0/24' } })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(AllocationModule.NebiusAllocation.Provider, AllocationModule.NebiusAllocationProvider)
      expect(await runDiff(svc, { name: 'my-alloc', ipv4Public: { cidr: '10.0.0.0/24' } }, { name: 'my-alloc', ipv4Public: { cidr: '10.0.0.0/24' } })).toBeUndefined()
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
