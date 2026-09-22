/**
 * C1 — the converge-or-declare sweep, one table per resource.
 *
 * See `tests/helpers/convergence.ts` for what the sweep asserts and why. This file is the
 * *content*: for every resource, a valid baseline, a patch per prop, and the props that are
 * deliberately not converged (with the reason).
 *
 * Scope note: a resource whose reconcile compares the **whole desired spec**
 * (`specDeepEqual(live.spec, desired)`) converges for every prop by construction — those are
 * tabulated in `tests/convergence-whole-spec.test.ts`. This file covers the resources whose
 * drift list **enumerates** fields, which is the only place the silent-loss bug can live, and
 * the ones whose drift list is an exported function (`instanceSpecDrifted`).
 */
import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import * as GpuClusterModule from '../modules/resources/compute/v1/gpu-cluster.ts'
import * as GpuClusterSchema from '../modules/resources/compute/v1/gpu-cluster.schema.ts'
import * as InstanceModule from '../modules/resources/compute/v1/instance.ts'
import * as InstanceSchema from '../modules/resources/compute/v1/instance.schema.ts'
import * as ComputeModule from '../modules/resources/compute/v1/disk.ts'
import * as ComputeSchema from '../modules/resources/compute/v1/disk.schema.ts'
import * as ImageModule from '../modules/resources/compute/v1/image.ts'
import * as ImageSchema from '../modules/resources/compute/v1/image.schema.ts'
import * as AsymmetricKeyModule from '../modules/resources/kms/v1/asymmetric-key.ts'
import * as AsymmetricKeySchema from '../modules/resources/kms/v1/asymmetric-key.schema.ts'
import * as SymmetricKeyModule from '../modules/resources/kms/v1/symmetric-key.ts'
import * as SymmetricKeySchema from '../modules/resources/kms/v1/symmetric-key.schema.ts'
import * as AccessPermitModule from '../modules/resources/iam/v1/access-permit.ts'
import * as AccessPermitSchema from '../modules/resources/iam/v1/access-permit.schema.ts'
import * as GroupModule from '../modules/resources/iam/v1/group.ts'
import * as GroupSchema from '../modules/resources/iam/v1/group.schema.ts'
import * as GroupMembershipModule from '../modules/resources/iam/v1/group-membership.ts'
import * as GroupMembershipSchema from '../modules/resources/iam/v1/group-membership.schema.ts'
import * as StaticKeyModule from '../modules/resources/iam/v1/static-key.ts'
import * as StaticKeySchema from '../modules/resources/iam/v1/static-key.schema.ts'
import * as ProjectModule from '../modules/resources/iam/v2/project.ts'
import * as ProjectSchema from '../modules/resources/iam/v2/project.schema.ts'
import * as SecretModule from '../modules/resources/mysterybox/v1/secret.ts'
import * as SecretVersionModule from '../modules/resources/mysterybox/v1/secret-version.ts'
import * as SecretVersionSchema from '../modules/resources/mysterybox/v1/secret-version.schema.ts'
import * as SecretSchema from '../modules/resources/mysterybox/v1/secret.schema.ts'
import * as RouteTableModule from '../modules/resources/vpc/v1/route-table.ts'
import * as RouteTableSchema from '../modules/resources/vpc/v1/route-table.schema.ts'
import * as SecurityGroupModule from '../modules/resources/vpc/v1/security-group.ts'
import * as SecurityGroupSchema from '../modules/resources/vpc/v1/security-group.schema.ts'
import * as RecordModule from '../modules/resources/dns/v1/record.ts'
import * as RecordSchema from '../modules/resources/dns/v1/record.schema.ts'
import * as ZoneModule from '../modules/resources/dns/v1/zone.ts'
import * as ZoneSchema from '../modules/resources/dns/v1/zone.schema.ts'
import * as NetworkModule from '../modules/resources/vpc/v1/network.ts'
import * as NetworkSchema from '../modules/resources/vpc/v1/network.schema.ts'
import * as PoolModule from '../modules/resources/vpc/v1/pool.ts'
import * as PoolSchema from '../modules/resources/vpc/v1/pool.schema.ts'
import * as RouteModule from '../modules/resources/vpc/v1/route.ts'
import * as RouteSchema from '../modules/resources/vpc/v1/route.schema.ts'
import * as SecurityRuleModule from '../modules/resources/vpc/v1/security-rule.ts'
import * as SecurityRuleSchema from '../modules/resources/vpc/v1/security-rule.schema.ts'
import * as SubnetModule from '../modules/resources/vpc/v1/subnet.ts'
import * as SubnetSchema from '../modules/resources/vpc/v1/subnet.schema.ts'
import * as NebiusRecordSchema from '../schemas/nebius/dns/v1/record.ts'
import * as NebiusZoneSchema from '../schemas/nebius/dns/v1/zone.ts'
import * as NebiusDiskSchema from '../schemas/nebius/compute/v1/disk.ts'
import * as NebiusGpuClusterSchema from '../schemas/nebius/compute/v1/gpu_cluster.ts'
import * as NebiusInstanceSchema from '../schemas/nebius/compute/v1/instance.ts'
import * as NebiusAccessPermitSchema from '../schemas/nebius/iam/v1/access_permit.ts'
import * as NebiusGroupSchema from '../schemas/nebius/iam/v1/group.ts'
import * as NebiusGroupMembershipSchema from '../schemas/nebius/iam/v1/group_membership.ts'
import * as NebiusStaticKeySchema from '../schemas/nebius/iam/v1/static_key.ts'
import * as NebiusSecretVersionSchema from '../schemas/nebius/mysterybox/v1/secret_version.ts'
import * as NebiusImageSchema from '../schemas/nebius/compute/v1/image.ts'
import * as NebiusAsymmetricKeySchema from '../schemas/nebius/kms/v1/asymmetric_key.ts'
import * as NebiusSymmetricKeySchema from '../schemas/nebius/kms/v1/symmetric_key.ts'
import * as NebiusProjectSchema from '../schemas/nebius/iam/v2/project.ts'
import * as NebiusSecretSchema from '../schemas/nebius/mysterybox/v1/secret.ts'
import * as NebiusRouteTableSchema from '../schemas/nebius/vpc/v1/route_table.ts'
import * as NebiusSecurityGroupSchema from '../schemas/nebius/vpc/v1/security_group.ts'
import * as NebiusNetworkSchema from '../schemas/nebius/vpc/v1/network.ts'
import * as NebiusPoolSchema from '../schemas/nebius/vpc/v1/pool.ts'
import * as NebiusRouteSchema from '../schemas/nebius/vpc/v1/route.ts'
import * as NebiusSecurityRuleSchema from '../schemas/nebius/vpc/v1/security_rule.ts'
import * as NebiusSubnetSchema from '../schemas/nebius/vpc/v1/subnet.ts'
import * as BucketModule from '../modules/resources/storage/v1/bucket.ts'
import * as BucketSchema from '../modules/resources/storage/v1/bucket.schema.ts'
import * as NebiusBucketSchema from '../schemas/nebius/storage/v1/bucket.ts'
import { convergenceSweep, planned } from './helpers/convergence.ts'
import { runDiff } from './helpers/provider.ts'
import {
  instanceIdLayer,
  mockComputeLayer,
  mockDnsLayer,
  mockIamLayer,
  mockKmsLayer,
  mockMysteryboxLayer,
  mockStorageLayer,
  mockVpcLayer,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from './helpers/mocks.ts'

const { describe } = BunTest

/** The layers every provider needs besides its own service mock. */
const baseLayers = [stackLayer, testConfigLayer, instanceIdLayer]
const base = <A, E, R>(service: Layer.Layer<A, E, R>) => Layer.mergeAll(service, ...baseLayers)

// ---------------------------------------------------------------------------
// Nebius.dns.v1.Record
// ---------------------------------------------------------------------------

const RECORD_ID = 'record-1'
const recordProps = { parentId: 'zone-1', relativeName: 'www', type: 'A', data: '10.0.0.1', ttl: 60 }
const recordLive = (): NebiusRecordSchema.Record => ({
  metadata: protoMetadata(RECORD_ID, 'www-a', 'zone-1'),
  spec: NebiusRecordSchema.RecordSpec.fromJSON(recordProps),
  status: undefined,
})

describe('Nebius.dns.v1.Record convergence', () => {
  convergenceSweep({
    resource: 'Nebius.dns.v1.Record',
    provider: RecordModule.NebiusRecord.Provider,
    providerLayer: RecordModule.NebiusRecordProvider,
    propsSchema: RecordSchema.RecordPropsSchema,
    props: recordProps,
    change: {
      parentId: planned({ parentId: 'zone-2' }, { action: 'replace' }),
      relativeName: { relativeName: 'api' },
      type: { type: 'AAAA' },
      ttl: { ttl: 300 },
      data: { data: '10.0.0.2' },
      deletionProtection: { deletionProtection: true },
    },
    // `ttl` is optional in props but a non-optional int64 on the wire: an omitted prop encodes
    // as 0, which the API replaces with its default and echoes back — comparing that echo
    // would rewrite the record on every reconcile.
    omits: ['ttl'],
    live: recordLive(),
    liveId: RECORD_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockDnsLayer({
            record: {
              get: () => Effect.succeed(recordLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(recordLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(recordLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.dns.v1.Zone
// ---------------------------------------------------------------------------

const ZONE_ID = 'zone-1'
const zoneProps = {
  parentId: 'project-test-1',
  name: 'my-zone',
  domainName: 'example.com.',
  vpc: { primaryNetworkId: 'network-1' },
  soaSpec: { negativeTtl: 300 },
}
const zoneLive = (): NebiusZoneSchema.Zone => ({
  metadata: protoMetadata(ZONE_ID, 'my-zone', 'project-test-1'),
  spec: NebiusZoneSchema.ZoneSpec.fromJSON(zoneProps),
  status: undefined,
})

describe('Nebius.dns.v1.Zone convergence', () => {
  convergenceSweep({
    resource: 'Nebius.dns.v1.Zone',
    provider: ZoneModule.NebiusZone.Provider,
    providerLayer: ZoneModule.NebiusZoneProvider,
    propsSchema: ZoneSchema.ZonePropsSchema,
    props: zoneProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-zone' }, { action: 'replace' }),
      domainName: { domainName: 'other.com.' },
      vpc: { vpc: { primaryNetworkId: 'network-2' } },
      soaSpec: { soaSpec: { negativeTtl: 60 } },
    },
    declared: {
      labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)',
    },
    // SOA is opt-in and every field in it is optional, so an omitted `soaSpec` must not fire.
    omits: ['soaSpec'],
    live: zoneLive(),
    liveId: ZONE_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockDnsLayer({
            zone: {
              get: () => Effect.succeed(zoneLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(zoneLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(zoneLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.vpc.v1.SecurityRule
// ---------------------------------------------------------------------------

const RULE_ID = 'securityrule-1'
const ruleProps = {
  parentId: 'securitygroup-1',
  name: 'allow-ssh',
  direction: 'INGRESS',
  protocol: 'TCP',
  access: 'ALLOW',
  ingress: { sourceCidrs: ['10.0.0.0/8'] },
}
// `priority`/`type` are injected by `withRuleSpecDefaults`, so the live resource must carry
// those same defaults or the baseline would drift.
const ruleDefaults = { priority: 500, type: 'STATEFUL' }
const ruleLive = (): NebiusSecurityRuleSchema.SecurityRule => ({
  metadata: protoMetadata(RULE_ID, 'allow-ssh', 'securitygroup-1'),
  spec: NebiusSecurityRuleSchema.SecurityRuleSpec.fromJSON({ ...ruleProps, ...ruleDefaults }),
  status: {
    state: NebiusSecurityRuleSchema.SecurityRuleStatus_State.READY,
    effectivePriority: 500,
    direction: NebiusSecurityRuleSchema.RuleDirection.INGRESS,
    source: undefined,
    destination: undefined,
  },
})

describe('Nebius.vpc.v1.SecurityRule convergence', () => {
  convergenceSweep({
    resource: 'Nebius.vpc.v1.SecurityRule',
    provider: SecurityRuleModule.NebiusSecurityRule.Provider,
    providerLayer: SecurityRuleModule.NebiusSecurityRuleProvider,
    propsSchema: SecurityRuleSchema.SecurityRulePropsSchema,
    props: ruleProps,
    change: {
      parentId: planned({ parentId: 'securitygroup-2' }, { action: 'replace' }),
      name: planned({ name: 'deny-ssh' }, { action: 'replace' }),
      protocol: { protocol: 'UDP' },
      access: { access: 'DENY' },
      priority: { priority: 600 },
      type: { type: 'STATELESS' },
      ingress: { ingress: { sourceCidrs: ['192.168.0.0/16'] } },
      // The only way to change direction is to swap the match block it selects — and that is
      // what converges (the rule is recreated; `ingress` alone stays an in-place update).
      egress: {
        direction: 'EGRESS',
        egress: { destinationCidrs: ['0.0.0.0/0'] },
        ingress: undefined,
      },
    },
    declared: {
      labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)',
      direction:
        'status-derived selector: `SecurityRuleSpec` has no `direction` — the API infers it from which match block is present and returns it in `status.direction`, so it converges *through* the `ingress`/`egress` rows above (see AGENTS.md §Convergence)',
    },
    // Both are provider-defaulted, so omitting them must not look like drift.
    omits: ['priority', 'type'],
    live: ruleLive(),
    liveId: RULE_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockVpcLayer({
            securityRule: {
              get: () => Effect.succeed(ruleLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(ruleLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(ruleLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.vpc.v1.Network / Subnet / Pool / Route
// ---------------------------------------------------------------------------

const NETWORK_ID = 'network-1'
const networkProps = { parentId: 'project-test-1', name: 'my-net', ipv4PrivatePools: { pools: [{ id: 'pool-1' }] } }
const networkLive = (): NebiusNetworkSchema.Network => ({
  metadata: protoMetadata(NETWORK_ID, 'my-net', 'project-test-1'),
  spec: NebiusNetworkSchema.NetworkSpec.fromJSON(networkProps),
  status: undefined,
})

describe('Nebius.vpc.v1.Network convergence', () => {
  convergenceSweep({
    resource: 'Nebius.vpc.v1.Network',
    provider: NetworkModule.NebiusNetwork.Provider,
    providerLayer: NetworkModule.NebiusNetworkProvider,
    propsSchema: NetworkSchema.NetworkPropsSchema,
    props: networkProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-net' }, { action: 'replace' }),
      ipv4PrivatePools: { ipv4PrivatePools: { pools: [{ id: 'pool-2' }] } },
      ipv4PublicPools: { ipv4PublicPools: { pools: [{ id: 'pool-3' }] } },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: networkLive(),
    liveId: NETWORK_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockVpcLayer({
            network: {
              get: () => Effect.succeed(networkLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(networkLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(networkLive())
              },
            },
          }),
        ),
      ),
  })
})

const SUBNET_ID = 'subnet-1'
const subnetProps = {
  parentId: 'project-test-1',
  name: 'my-subnet',
  networkId: 'network-1',
  ipv4PrivatePools: { pools: [{ cidrs: [{ cidr: '10.1.0.0/24' }] }] },
  routeTableId: 'routetable-1',
}
const subnetLive = (): NebiusSubnetSchema.Subnet => ({
  metadata: protoMetadata(SUBNET_ID, 'my-subnet', 'project-test-1'),
  spec: NebiusSubnetSchema.SubnetSpec.fromJSON(subnetProps),
  status: undefined,
})

describe('Nebius.vpc.v1.Subnet convergence', () => {
  convergenceSweep({
    resource: 'Nebius.vpc.v1.Subnet',
    provider: SubnetModule.NebiusSubnet.Provider,
    providerLayer: SubnetModule.NebiusSubnetProvider,
    propsSchema: SubnetSchema.SubnetPropsSchema,
    props: subnetProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-subnet' }, { action: 'replace' }),
      networkId: { networkId: 'network-2' },
      ipv4PrivatePools: { ipv4PrivatePools: { pools: [{ cidrs: [{ cidr: '10.2.0.0/24' }] }] } },
      ipv4PublicPools: { ipv4PublicPools: { pools: [{ cidrs: [{ cidr: '203.0.113.0/24' }] }] } },
      routeTableId: { routeTableId: 'routetable-2' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    // The API assigns a default route table when none is given, so an omitted `routeTableId`
    // must not look like drift against the assigned one.
    omits: ['routeTableId'],
    live: subnetLive(),
    liveId: SUBNET_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockVpcLayer({
            subnet: {
              get: () => Effect.succeed(subnetLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(subnetLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(subnetLive())
              },
            },
          }),
        ),
      ),
  })
})

const POOL_ID = 'pool-1'
const poolProps = {
  parentId: 'project-test-1',
  name: 'my-pool',
  version: 'IPV4',
  visibility: 'PRIVATE',
  cidrs: [{ cidr: '10.0.0.0/8' }],
}
const poolLive = (): NebiusPoolSchema.Pool => ({
  metadata: protoMetadata(POOL_ID, 'my-pool', 'project-test-1'),
  spec: NebiusPoolSchema.PoolSpec.fromJSON(poolProps),
  status: undefined,
})

describe('Nebius.vpc.v1.Pool convergence', () => {
  convergenceSweep({
    resource: 'Nebius.vpc.v1.Pool',
    provider: PoolModule.NebiusPool.Provider,
    providerLayer: PoolModule.NebiusPoolProvider,
    propsSchema: PoolSchema.PoolPropsSchema,
    props: poolProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-pool' }, { action: 'replace' }),
      sourcePoolId: { sourcePoolId: 'pool-2' },
      version: { version: 'IPV6' },
      visibility: { visibility: 'PUBLIC' },
      cidrs: { cidrs: [{ cidr: '10.1.0.0/8' }] },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: poolLive(),
    liveId: POOL_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockVpcLayer({
            pool: {
              get: () => Effect.succeed(poolLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(poolLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(poolLive())
              },
            },
          }),
        ),
      ),
  })
})

const ROUTE_ID = 'route-1'
const routeProps = {
  parentId: 'routetable-1',
  name: 'default-egress',
  destination: { cidr: '0.0.0.0/0' },
  nextHop: { defaultEgressGateway: true },
}
const routeLive = (): NebiusRouteSchema.Route => ({
  metadata: protoMetadata(ROUTE_ID, 'default-egress', 'routetable-1'),
  spec: NebiusRouteSchema.RouteSpec.fromJSON(routeProps),
  status: undefined,
})

describe('Nebius.vpc.v1.Route convergence', () => {
  convergenceSweep({
    resource: 'Nebius.vpc.v1.Route',
    provider: RouteModule.NebiusRoute.Provider,
    providerLayer: RouteModule.NebiusRouteProvider,
    propsSchema: RouteSchema.RoutePropsSchema,
    props: routeProps,
    change: {
      parentId: planned({ parentId: 'routetable-2' }, { action: 'replace' }),
      name: planned({ name: 'other-route' }, { action: 'replace' }),
      destination: { destination: { cidr: '10.0.0.0/8' } },
      nextHop: { nextHop: { allocation: { id: 'allocation-1' } } },
      description: { description: 'a route' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: routeLive(),
    liveId: ROUTE_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockVpcLayer({
            route: {
              get: () => Effect.succeed(routeLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(routeLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(routeLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.compute.v1.Disk
// ---------------------------------------------------------------------------

const DISK_ID = 'disk-1'
const diskProps = {
  parentId: 'project-test-1',
  name: 'data-disk',
  type: 'NETWORK_SSD',
  sizeGibibytes: 64,
  blockSizeBytes: 4096,
}
const diskLive = (): NebiusDiskSchema.Disk => ({
  metadata: protoMetadata(DISK_ID, 'data-disk', 'project-test-1'),
  spec: NebiusDiskSchema.DiskSpec.fromJSON(diskProps),
  status: undefined,
})

describe('Nebius.compute.v1.Disk convergence', () => {
  convergenceSweep({
    resource: 'Nebius.compute.v1.Disk',
    provider: ComputeModule.NebiusDisk.Provider,
    providerLayer: ComputeModule.NebiusDiskProvider,
    propsSchema: ComputeSchema.DiskPropsSchema,
    props: diskProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-disk' }, { action: 'replace' }),
      sizeGibibytes: { sizeGibibytes: 128 },
      blockSizeBytes: { blockSizeBytes: 8192 },
      type: { type: 'NETWORK_HDD' },
      sourceImageId: { sourceImageId: 'image-1' },
      sourceImageFamily: { sourceImageFamily: { imageFamily: 'ubuntu-24.04' } },
      sourceSnapshotId: { sourceSnapshotId: 'disksnapshot-1' },
      diskEncryption: { diskEncryption: { type: 'DISK_ENCRYPTION_MANAGED' } },
      forbidDeletion: { forbidDeletion: true },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    // `sizeGibibytes` is optional in props but the live disk always has one, and
    // `blockSizeBytes` is a non-optional int64 the API defaults to 4096 — an omitted prop
    // must not become "drift" against the value the platform already holds.
    omits: ['sizeGibibytes', 'blockSizeBytes'],
    live: diskLive(),
    liveId: DISK_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockComputeLayer({
            disk: {
              get: () => Effect.succeed(diskLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(diskLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(diskLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.compute.v1.Image
// ---------------------------------------------------------------------------

const IMAGE_ID = 'image-1'
const imageProps = {
  parentId: 'project-test-1',
  name: 'my-image',
  sourceDiskId: 'disk-1',
  cpuArchitecture: 'AMD64',
}
const imageLive = (): NebiusImageSchema.Image => ({
  metadata: protoMetadata(IMAGE_ID, 'my-image', 'project-test-1'),
  spec: NebiusImageSchema.ImageSpec.fromJSON(imageProps),
  status: undefined,
})

describe('Nebius.compute.v1.Image convergence', () => {
  convergenceSweep({
    resource: 'Nebius.compute.v1.Image',
    provider: ImageModule.NebiusImage.Provider,
    providerLayer: ImageModule.NebiusImageProvider,
    propsSchema: ImageSchema.ImagePropsSchema,
    props: imageProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-image' }, { action: 'replace' }),
      description: { description: 'built by CI' },
      imageFamily: { imageFamily: 'ubuntu-24.04' },
      version: { version: '2026.09' },
      imageFamilyHumanReadable: { imageFamilyHumanReadable: 'Ubuntu 24.04' },
      // The create source is a `oneof`: probing a different source means swapping it.
      sourceDiskId: { sourceDiskId: 'disk-2' },
      sourceDiskSnapshotId: { sourceDiskSnapshotId: 'disksnapshot-1', sourceDiskId: undefined },
      sourceStorage: {
        sourceStorage: { bucketName: 'images', objectName: 'ubuntu.qcow2' },
        sourceDiskId: undefined,
      },
      cpuArchitecture: { cpuArchitecture: 'ARM64' },
      recommendedPlatforms: { recommendedPlatforms: ['gpu-h100'] },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    // The platform substitutes its own default (AMD64) when the prop is omitted.
    omits: ['cpuArchitecture'],
    live: imageLive(),
    liveId: IMAGE_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockComputeLayer({
            image: {
              get: () => Effect.succeed(imageLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(imageLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(imageLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.kms.v1.SymmetricKey
// ---------------------------------------------------------------------------

const KEY_ID = 'symmetrickey-1'
const keyProps = {
  parentId: 'project-test-1',
  name: 'my-key',
  algorithm: 'AES_256',
  rotationPeriodSeconds: 2_592_000,
}
const keyLive = (): NebiusSymmetricKeySchema.SymmetricKey => ({
  metadata: protoMetadata(KEY_ID, 'my-key', 'project-test-1'),
  spec: NebiusSymmetricKeySchema.SymmetricKeySpec.fromJSON({
    description: '',
    algorithm: 'AES_256',
    rotationPeriod: { seconds: '2592000' },
  }),
  status: undefined,
})

describe('Nebius.kms.v1.SymmetricKey convergence', () => {
  convergenceSweep({
    resource: 'Nebius.kms.v1.SymmetricKey',
    provider: SymmetricKeyModule.NebiusSymmetricKey.Provider,
    providerLayer: SymmetricKeyModule.NebiusSymmetricKeyProvider,
    propsSchema: SymmetricKeySchema.SymmetricKeyPropsSchema,
    props: keyProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-key' }, { action: 'replace' }),
      description: { description: 'encrypts the backups' },
      rotationPeriodSeconds: { rotationPeriodSeconds: 86_400 },
    },
    declared: {
      labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)',
      algorithm:
        'single-valued and immutable: `SymmetricAlgorithmSchema` admits only `AES_256`, and the provider treats it as immutable — there is no change to converge (the `diff` clause is a defensive net for a value validation makes unreachable)',
    },
    // Rotation is opt-in: the server applies its own period when none is given.
    omits: ['rotationPeriodSeconds'],
    live: keyLive(),
    liveId: KEY_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockKmsLayer({
            symmetricKey: {
              get: () => Effect.succeed(keyLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(keyLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(keyLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.storage.v1.Bucket
// ---------------------------------------------------------------------------

const BUCKET_ID = 'bucket-1'
const bucketProps = { parentId: 'project-test-1', name: 'my-bucket' }
const bucketLive = (): NebiusBucketSchema.Bucket => ({
  metadata: protoMetadata(BUCKET_ID, 'my-bucket', 'project-test-1'),
  spec: NebiusBucketSchema.BucketSpec.fromJSON(bucketProps),
  status: undefined,
})

describe('Nebius.storage.v1.Bucket convergence', () => {
  convergenceSweep({
    resource: 'Nebius.storage.v1.Bucket',
    provider: BucketModule.NebiusBucket.Provider,
    providerLayer: BucketModule.NebiusBucketProvider,
    propsSchema: BucketSchema.BucketPropsSchema,
    props: bucketProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-bucket' }, { action: 'replace' }),
      maxSizeBytes: { maxSizeBytes: 1_073_741_824n },
      lifecycleConfiguration: {
        lifecycleConfiguration: { rules: [{ action: { type: 'Delete' }, condition: { age: 30 } }] },
      },
      cors: {
        cors: { rules: [{ allowedOrigins: ['https://example.com'], allowedMethods: ['GET'] }] },
      },
      forceStorageClass: { forceStorageClass: true },
      bucketPolicy: { bucketPolicy: { rules: [{ paths: ['*'], roles: ['viewer'] }] } },
      versioningPolicy: { versioningPolicy: 'ENABLED' },
      defaultStorageClass: { defaultStorageClass: 'ENHANCED_THROUGHPUT' },
      objectAuditLogging: { objectAuditLogging: 'ALL' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    // The platform reports 0 ("unlimited") for an unset quota — an unset int64 must not
    // fabricate drift (the `Long.ZERO` vs `undefined` trap).
    omits: ['maxSizeBytes'],
    live: bucketLive(),
    liveId: BUCKET_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockStorageLayer({
            bucket: {
              get: () => Effect.succeed(bucketLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(bucketLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(bucketLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.iam.v2.Project / KMS asymmetric key / MysteryBox secret
// / VPC route table + security group
//
// These five compare a *single* spec field (`region`, `description`,
// `description`, `networkId`, `networkId`), which is exactly the shape where a
// forgotten prop is silently lost — the sweep is what makes that explicit.
// ---------------------------------------------------------------------------

/** A resource whose reconcile compares one named spec field. */
const singleFieldResource = (resource: string) => resource

const PROJECT_ID = 'project-1'
const projectProps = { parentId: 'tenant-1', name: 'my-project', region: 'eu-north1' }
const projectLive = (): NebiusProjectSchema.Project => ({
  metadata: protoMetadata(PROJECT_ID, 'my-project', 'tenant-1'),
  spec: NebiusProjectSchema.ProjectSpec.fromPartial({ region: 'eu-north1' }),
  status: undefined,
})

describe(`${singleFieldResource('Nebius.iam.v2.Project')} convergence`, () => {
  convergenceSweep({
    resource: 'Nebius.iam.v2.Project',
    provider: ProjectModule.NebiusProject.Provider,
    providerLayer: ProjectModule.NebiusProjectProvider,
    propsSchema: ProjectSchema.ProjectPropsSchema,
    props: projectProps,
    change: {
      parentId: planned({ parentId: 'tenant-2' }, { action: 'replace' }),
      name: planned({ name: 'other-project' }, { action: 'replace' }),
      region: { region: 'eu-west1' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: projectLive(),
    liveId: PROJECT_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockIamLayer({
            project: {
              get: () => Effect.succeed(projectLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(projectLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(projectLive())
              },
            },
          }),
        ),
      ),
  })
})

const ASYMMETRIC_ID = 'asymmetrickey-1'
const asymmetricProps = {
  parentId: 'project-test-1',
  name: 'my-signing-key',
  description: 'signs releases',
  algorithm: 'ECDSA_NIST_P256_SHA_256',
}
const asymmetricLive = (): NebiusAsymmetricKeySchema.AsymmetricKey => ({
  metadata: protoMetadata(ASYMMETRIC_ID, 'my-signing-key', 'project-test-1'),
  spec: NebiusAsymmetricKeySchema.AsymmetricKeySpec.fromJSON({
    description: 'signs releases',
    algorithm: 'ECDSA_NIST_P256_SHA_256',
  }),
  status: undefined,
})

describe('Nebius.kms.v1.AsymmetricKey convergence', () => {
  convergenceSweep({
    resource: 'Nebius.kms.v1.AsymmetricKey',
    provider: AsymmetricKeyModule.NebiusAsymmetricKey.Provider,
    providerLayer: AsymmetricKeyModule.NebiusAsymmetricKeyProvider,
    propsSchema: AsymmetricKeySchema.AsymmetricKeyPropsSchema,
    props: asymmetricProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-key' }, { action: 'replace' }),
      description: { description: 'verifies releases' },
      algorithm: { algorithm: 'RSA_4096_ENC_OAEP_SHA_256' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: asymmetricLive(),
    liveId: ASYMMETRIC_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockKmsLayer({
            asymmetricKey: {
              get: () => Effect.succeed(asymmetricLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(asymmetricLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(asymmetricLive())
              },
            },
          }),
        ),
      ),
  })
})

const SECRET_ID = 'secret-1'
const secretProps = {
  parentId: 'project-test-1',
  name: 'my-secret',
  description: 'db password',
  payloads: [{ key: 'password', stringValue: 'hunter2' }],
}
const secretLive = (): NebiusSecretSchema.Secret => ({
  metadata: protoMetadata(SECRET_ID, 'my-secret', 'project-test-1'),
  spec: NebiusSecretSchema.SecretSpec.fromJSON({ description: 'db password' }),
  status: undefined,
})

describe('Nebius.mysterybox.v1.Secret convergence', () => {
  convergenceSweep({
    resource: 'Nebius.mysterybox.v1.Secret',
    provider: SecretModule.NebiusSecret.Provider,
    providerLayer: SecretModule.NebiusSecretProvider,
    propsSchema: SecretSchema.SecretPropsSchema,
    props: secretProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-secret' }, { action: 'replace' }),
      description: { description: 'redis password' },
    },
    declared: {
      labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)',
      payloads:
        'create-only by design: the prop seeds the first secret version (see the props doc comment); later payloads go through Nebius.mysterybox.v1.SecretVersion',
    },
    live: secretLive(),
    liveId: SECRET_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockMysteryboxLayer({
            secret: {
              get: () => Effect.succeed(secretLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(secretLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(secretLive())
              },
            },
          }),
        ),
      ),
  })
})

const ROUTE_TABLE_ID = 'routetable-1'
const routeTableProps = { parentId: 'project-test-1', name: 'my-routes', networkId: 'network-1' }
const routeTableLive = (): NebiusRouteTableSchema.RouteTable => ({
  metadata: protoMetadata(ROUTE_TABLE_ID, 'my-routes', 'project-test-1'),
  spec: NebiusRouteTableSchema.RouteTableSpec.fromJSON({ networkId: 'network-1' }),
  status: undefined,
})

describe('Nebius.vpc.v1.RouteTable convergence', () => {
  convergenceSweep({
    resource: 'Nebius.vpc.v1.RouteTable',
    provider: RouteTableModule.NebiusRouteTable.Provider,
    providerLayer: RouteTableModule.NebiusRouteTableProvider,
    propsSchema: RouteTableSchema.RouteTablePropsSchema,
    props: routeTableProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-routes' }, { action: 'replace' }),
      networkId: { networkId: 'network-2' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: routeTableLive(),
    liveId: ROUTE_TABLE_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockVpcLayer({
            routeTable: {
              get: () => Effect.succeed(routeTableLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(routeTableLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(routeTableLive())
              },
            },
          }),
        ),
      ),
  })
})

const SECURITY_GROUP_ID = 'securitygroup-1'
const securityGroupProps = { parentId: 'project-test-1', name: 'my-sg', networkId: 'network-1' }
const securityGroupLive = (): NebiusSecurityGroupSchema.SecurityGroup => ({
  metadata: protoMetadata(SECURITY_GROUP_ID, 'my-sg', 'project-test-1'),
  spec: NebiusSecurityGroupSchema.SecurityGroupSpec.fromJSON({ networkId: 'network-1' }),
  status: undefined,
})

describe('Nebius.vpc.v1.SecurityGroup convergence', () => {
  convergenceSweep({
    resource: 'Nebius.vpc.v1.SecurityGroup',
    provider: SecurityGroupModule.NebiusSecurityGroup.Provider,
    providerLayer: SecurityGroupModule.NebiusSecurityGroupProvider,
    propsSchema: SecurityGroupSchema.SecurityGroupPropsSchema,
    props: securityGroupProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-sg' }, { action: 'replace' }),
      networkId: { networkId: 'network-2' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: securityGroupLive(),
    liveId: SECURITY_GROUP_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockVpcLayer({
            securityGroup: {
              get: () => Effect.succeed(securityGroupLive()),
              update: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(securityGroupLive())
              },
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(securityGroupLive())
              },
            },
          }),
        ),
      ),
  })
})

// ---------------------------------------------------------------------------
// Nebius.compute.v1.Instance
//
// The largest props surface (26), and the resource the 2026-09-19 sweep found two
// silent losses in (`recoveryPolicy`, `hostname`) — so it is tabulated prop by prop
// even though its drift list is already an exported, unit-tested function.
//
// `probe` bypasses mocked reconcile on purpose: `instanceSpecDrifted` *is* the drift
// list, and `diff` is pure, so the whole convergence question is answerable without a
// compute mock (and without the hosted machinery, which needs a filesystem).
// ---------------------------------------------------------------------------

const INSTANCE_ID = 'instance-1'
const instanceProps = {
  parentId: 'project-test-1',
  name: 'my-instance',
  serviceAccountId: 'serviceaccount-abc123',
  resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
  bootDisk: {
    attachMode: 'READ_WRITE',
    managedDisk: {
      name: 'boot-disk',
      spec: {
        type: 'NETWORK_SSD',
        sizeGibibytes: 64,
        sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
      },
    },
  },
  networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
}

describe('Nebius.compute.v1.Instance convergence', () => {
  convergenceSweep({
    resource: 'Nebius.compute.v1.Instance',
    provider: InstanceModule.NebiusInstance.Provider,
    providerLayer: InstanceModule.NebiusInstanceProvider,
    propsSchema: InstanceSchema.InstancePropsSchema,
    props: instanceProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-instance' }, { action: 'replace' }),
      serviceAccountId: { serviceAccountId: 'serviceaccount-def456' },
      resources: { resources: { platform: 'cpu-d3', preset: '8vcpu-32gb' } },
      bootDisk: {
        bootDisk: {
          attachMode: 'READ_WRITE',
          managedDisk: {
            name: 'boot-disk',
            spec: {
              type: 'NETWORK_SSD',
              sizeGibibytes: 128,
              sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
            },
          },
        },
      },
      secondaryDisks: {
        secondaryDisks: [
          {
            attachMode: 'READ_WRITE',
            // Deliberately blank (no source image): a fresh data volume. Before
            // `bootDiskImageRequired` moved to the boot disk, this row had to smuggle in an OS
            // image to get past validation — which is how the over-broad filter was found.
            managedDisk: { name: 'data-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 128 } },
          },
        ],
      },
      filesystems: {
        filesystems: [
          { attachMode: 'READ_WRITE', mountTag: 'data', existingFilesystem: { id: 'filesystem-abc123' } },
        ],
      },
      localDisks: { localDisks: { passthroughGroup: { requested: true } } },
      reservationPolicy: { reservationPolicy: { policy: 'AUTO', reservationIds: [] } },
      nvlInstanceGroupId: { nvlInstanceGroupId: 'nvlinstancegroup-abc123' },
      networkInterfaces: {
        networkInterfaces: [{ subnetId: 'subnet-def456', name: 'eth0', ipAddress: { allocationId: '' } }],
      },
      gpuCluster: { gpuCluster: { id: 'gpucluster-abc123' } },
      recoveryPolicy: { recoveryPolicy: 'FAIL' },
      preemptible: { preemptible: { onPreemption: 'STOP' } },
      stopped: { stopped: true },
      hostname: { hostname: 'my-instance.example.com' },
      cloudInitUserData: { cloudInitUserData: '#cloud-config\nruncmd: []' },
    },
    declared: {
      labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)',
      // The hosted-program props are not instance spec fields at all: they drive the
      // Effectful-compute path (bundle, S3 assets, service account) rather than the VM's
      // `InstanceSpec`, so there is no spec comparison for them to converge through.
      main: 'hosted entry point, not an InstanceSpec field (see the Effectful-compute patterns)',
      handler: 'hosted entry point, not an InstanceSpec field',
      port: 'hosted HTTP port, not an InstanceSpec field',
      env: 'hosted environment, not an InstanceSpec field',
      build: 'bundle configuration, not an InstanceSpec field',
      isExternal: 'hosted entry mode, not an InstanceSpec field',
      bucket: 'hosted S3 asset bucket, not an InstanceSpec field',
      hosted: 'hosted sub-resources (service account, key, bucket), not an InstanceSpec field',
    },
    live: NebiusInstanceSchema.InstanceSpec.fromJSON(instanceProps),
    liveId: INSTANCE_ID,
    probe: async (svc, news, baseline) =>
      (await runDiff(svc, news, baseline)) !== undefined ||
      InstanceModule.instanceSpecDrifted(
        NebiusInstanceSchema.InstanceSpec.fromJSON(baseline),
        NebiusInstanceSchema.InstanceSpec.fromJSON(news),
        news as never,
      ),
  })
})

// ---------------------------------------------------------------------------
// The resources with no `Update` RPC
//
// For these, `diff` is the **only** convergence path, so a prop it ignores is lost outright:
// a change plans an `update` that reconcile cannot write (AGENTS.md §Convergence). Each used
// to carry a hand-written prop-set guard, which could only say "the prop set did not change";
// the sweep subsumes it — every prop is probed for behaviour (a plan must appear), and the
// completeness check fails on a new prop until someone classifies it.
// ---------------------------------------------------------------------------

const GPU_CLUSTER_ID = 'gpucluster-1'
const gpuClusterProps = { parentId: 'project-test-1', name: 'my-cluster', infinibandFabric: 'fabric-1' }
const gpuClusterLive = (): NebiusGpuClusterSchema.GpuCluster => ({
  metadata: protoMetadata(GPU_CLUSTER_ID, 'my-cluster', 'project-test-1'),
  spec: NebiusGpuClusterSchema.GpuClusterSpec.fromJSON({ infinibandFabric: 'fabric-1' }),
  status: undefined,
})

describe('Nebius.compute.v1.GpuCluster convergence', () => {
  convergenceSweep({
    resource: 'Nebius.compute.v1.GpuCluster',
    provider: GpuClusterModule.NebiusGpuCluster.Provider,
    providerLayer: GpuClusterModule.NebiusGpuClusterProvider,
    propsSchema: GpuClusterSchema.GpuClusterPropsSchema,
    props: gpuClusterProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-cluster' }, { action: 'replace' }),
      // Immutable physical fabric: a different one means a different cluster.
      infinibandFabric: { infinibandFabric: 'fabric-2' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: gpuClusterLive(),
    liveId: GPU_CLUSTER_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockComputeLayer({
            gpuCluster: {
              get: () => Effect.succeed(gpuClusterLive()),
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(gpuClusterLive())
              },
            },
          }),
        ),
      ),
  })
})

const GROUP_ID = 'group-1'
const groupProps = { parentId: 'project-test-1', name: 'my-group' }
const groupLive = (): NebiusGroupSchema.Group => ({
  metadata: protoMetadata(GROUP_ID, 'my-group', 'project-test-1'),
  spec: NebiusGroupSchema.GroupSpec.fromJSON({}),
  status: undefined,
})

describe('Nebius.iam.v1.Group convergence', () => {
  convergenceSweep({
    resource: 'Nebius.iam.v1.Group',
    provider: GroupModule.NebiusGroup.Provider,
    providerLayer: GroupModule.NebiusGroupProvider,
    propsSchema: GroupSchema.GroupPropsSchema,
    props: groupProps,
    change: {
      parentId: planned({ parentId: 'project-2' }, { action: 'replace' }),
      name: planned({ name: 'other-group' }, { action: 'replace' }),
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: groupLive(),
    liveId: GROUP_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockIamLayer({
            group: {
              get: () => Effect.succeed(groupLive()),
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(groupLive())
              },
            },
          }),
        ),
      ),
  })
})

const STATIC_KEY_ID = 'statickey-1'
const staticKeyProps = {
  serviceAccountId: 'serviceaccount-abc123',
  description: 'ci uploads',
  service: 'OBSERVABILITY',
  expiresAt: '2030-01-01T00:00:00Z',
}
const staticKeyLive = (): NebiusStaticKeySchema.StaticKey => ({
  metadata: protoMetadata(STATIC_KEY_ID, 'sk-test', 'serviceaccount-abc123'),
  spec: NebiusStaticKeySchema.StaticKeySpec.fromJSON({}),
  status: undefined,
})

describe('Nebius.iam.v1.StaticKey convergence', () => {
  convergenceSweep({
    resource: 'Nebius.iam.v1.StaticKey',
    provider: StaticKeyModule.NebiusStaticKey.Provider,
    providerLayer: StaticKeyModule.NebiusStaticKeyProvider,
    propsSchema: StaticKeySchema.StaticKeyPropsSchema,
    props: staticKeyProps,
    change: {
      // Every one of these is issue-time only, so a change must re-issue (the sweep is what
      // pinned that: `description`/`expiresAt` were silently ignored before 2026-09-19).
      serviceAccountId: { serviceAccountId: 'serviceaccount-def456' },
      description: { description: 'release uploads' },
      service: { service: 'CONTAINER_REGISTRY' },
      expiresAt: { expiresAt: '2031-01-01T00:00:00Z' },
    },
    live: staticKeyLive(),
    liveId: STATIC_KEY_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockIamLayer({
            staticKey: {
              get: () => Effect.succeed(staticKeyLive()),
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(staticKeyLive())
              },
            },
          }),
        ),
      ),
  })
})

const ACCESS_PERMIT_ID = 'accesspermit-1'
const accessPermitProps = { parentId: 'group-1', resourceId: 'project-1', role: 'viewer' }
const accessPermitLive = (): NebiusAccessPermitSchema.AccessPermit => ({
  metadata: protoMetadata(ACCESS_PERMIT_ID, 'ap-test', 'group-1'),
  spec: NebiusAccessPermitSchema.AccessPermitSpec.fromJSON({}),
  status: undefined,
})

describe('Nebius.iam.v1.AccessPermit convergence', () => {
  convergenceSweep({
    resource: 'Nebius.iam.v1.AccessPermit',
    provider: AccessPermitModule.NebiusAccessPermit.Provider,
    providerLayer: AccessPermitModule.NebiusAccessPermitProvider,
    propsSchema: AccessPermitSchema.AccessPermitPropsSchema,
    props: accessPermitProps,
    change: {
      parentId: planned({ parentId: 'group-2' }, { action: 'replace' }),
      // `resourceId` and `role` are immutable after creation (the permit's whole meaning).
      resourceId: { resourceId: 'project-2' },
      role: { role: 'editor' },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: accessPermitLive(),
    liveId: ACCESS_PERMIT_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockIamLayer({
            accessPermit: {
              get: () => Effect.succeed(accessPermitLive()),
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(accessPermitLive())
              },
            },
          }),
        ),
      ),
  })
})

const GROUP_MEMBERSHIP_ID = 'groupmembership-1'
const groupMembershipProps = { parentId: 'group-1', memberId: 'serviceaccount-abc123', revokeAfterHours: 24 }
const groupMembershipLive = (): NebiusGroupMembershipSchema.GroupMembership => ({
  metadata: protoMetadata(GROUP_MEMBERSHIP_ID, 'gm-test', 'group-1'),
  spec: NebiusGroupMembershipSchema.GroupMembershipSpec.fromJSON({}),
  status: undefined,
})

describe('Nebius.iam.v1.GroupMembership convergence', () => {
  convergenceSweep({
    resource: 'Nebius.iam.v1.GroupMembership',
    provider: GroupMembershipModule.NebiusGroupMembership.Provider,
    providerLayer: GroupMembershipModule.NebiusGroupMembershipProvider,
    propsSchema: GroupMembershipSchema.GroupMembershipPropsSchema,
    props: groupMembershipProps,
    change: {
      parentId: planned({ parentId: 'group-2' }, { action: 'replace' }),
      memberId: { memberId: 'serviceaccount-def456' },
      // The revoke schedule is fixed at creation, so a change re-issues the membership.
      revokeAfterHours: { revokeAfterHours: 48 },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: groupMembershipLive(),
    liveId: GROUP_MEMBERSHIP_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockIamLayer({
            groupMembership: {
              get: () => Effect.succeed(groupMembershipLive()),
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(groupMembershipLive())
              },
            },
          }),
        ),
      ),
  })
})

const SECRET_VERSION_ID = 'secretversion-1'
const secretVersionProps = {
  parentId: 'secret-1',
  description: 'v1',
  payload: [{ key: 'password', stringValue: 'hunter2' }],
}
const secretVersionLive = (): NebiusSecretVersionSchema.SecretVersion => ({
  metadata: protoMetadata(SECRET_VERSION_ID, 'sv-test', 'secret-1'),
  spec: NebiusSecretVersionSchema.SecretVersionSpec.fromJSON({}),
  status: undefined,
})

describe('Nebius.mysterybox.v1.SecretVersion convergence', () => {
  convergenceSweep({
    resource: 'Nebius.mysterybox.v1.SecretVersion',
    provider: SecretVersionModule.NebiusSecretVersion.Provider,
    providerLayer: SecretVersionModule.NebiusSecretVersionProvider,
    propsSchema: SecretVersionSchema.SecretVersionPropsSchema,
    props: secretVersionProps,
    change: {
      parentId: planned({ parentId: 'secret-2' }, { action: 'replace' }),
      name: planned({ name: 'sv-pinned' }, { action: 'replace' }),
      // Content changes cannot be applied in place (the service has no Update RPC), so they
      // replace — delete-first, because the version name is reused.
      description: { description: 'v2' },
      payload: { payload: [{ key: 'password', stringValue: 'hunter3' }] },
      setPrimary: { setPrimary: true },
    },
    declared: { labels: 'create-time only: no update path sends labels (AGENTS.md §Convergence)' },
    live: secretVersionLive(),
    liveId: SECRET_VERSION_ID,
    layerFor: (writes) =>
      Effect.provide(
        base(
          mockMysteryboxLayer({
            secretVersion: {
              get: () => Effect.succeed(secretVersionLive()),
              create: (req: unknown) => {
                writes.push(req)
                return Effect.succeed(secretVersionLive())
              },
            },
          }),
        ),
      ),
  })
})
