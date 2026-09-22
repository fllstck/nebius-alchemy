/**
 * Live-echo audit — TASKS.md §"What is left" E.
 *
 * One test per resource family. Each creates the whole family in ONE deploy, then:
 *
 *   1. **calibrates**: `metadata.resourceVersion` must be `1` per resource (one write: the create),
 *      unless the type's version is a documented non-counter — see
 *      `tests/helpers/live-echo.ts` for the oracle, the calibration table and the two assertions
 *      it makes. The 2026-09-22 probes found two resources failing this
 *      (`vpc/v1/{network,subnet}`: the API materializes their pool structs into `spec`, and the
 *      unguarded comparison re-sent an update);
 *   2. **re-deploys with `labels` added to every resource** — a props change `diff` ignores, so the
 *      planner resolves it to `action: "update"` and reconcile RUNS for each. It must write
 *      nothing. An identical re-deploy cannot probe this: that plan is a `noop`, so reconcile is
 *      never called and the drift list is never consulted.
 *
 * Resources the PLATFORM writes to on its own are exempt from the version assertions and are
 * checked for "the assigned values survived" instead (a `Network` gets real `vpcpool-` ids
 * assigned into its spec).
 *
 * Cost: cheap declarative resources only — no instances, no AI jobs/endpoints (code bundles + GPU
 * quota), no `iam/v1/invitation` (it emails a real person), no `nvl-instance-group` (needs GB200/
 * GB300 entitlement). SLOW_TESTS-gated like every other integration test.
 *
 * ## What is NOT here, and why (the coverage question, answered once)
 *
 * | resource | why it is not in this file |
 * | `iam/v1/invitation` | creating one emails a real person |
 * | `quotas/v1/quota-allowance` | creating one mutates real tenant quotas, and it has no stable id |
 * | `compute/v1/nvl-instance-group` | needs a GB200/GB300 entitlement this tenant does not have |
 * | `ai/v1/{job,endpoint}` | code bundles + GPU quota; they have their own gated e2e tests |
 * | `compute/v1/instance` (+ hosted variants) | cost and minutes per run; the hosted e2e covers it |
 * | `iam/v2/project` | only the forced-reconcile assertion is missing, and its spec is `{region}` — the lifecycle test already covers create/update/delete (110 s) |
 *
 * Resources whose drift list is a **whole-spec comparison** get priority here, because that pattern has
 * produced every echo bug so far (`network`/`subnet` pools, `pool` cidrs, `transfer`, `auth-public-key`,
 * `federation-certificate`):
 * `vpc/v1 allocation` ✓, `compute/v1 {filesystem,disk-snapshot}` ✓, `iam/v1 {federation,
 * federated-credentials,federation-certificate}` ✓, `storage/v1 transfer` (its own test), and — by
 * construction — `record`/`subnet`/`filesystem` in their own update-path probes.
 */
import { expect } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import { Nebius, test } from '../helpers/stack.ts'
import { integrationTest } from '../helpers/gate.ts'
import { safeDestroy } from '../helpers/cleanup.ts'
import {
  calibrateCreates,
  expectNoWrites,
  expectSpecUnchanged,
  readVersion,
  specSnapshot,
  type LiveEchoTarget,
} from '../helpers/live-echo.ts'
import { RSA_4096_PUBLIC_KEY_A, SELF_SIGNED_CERT } from '../helpers/fixtures.ts'
import * as VpcGrpc from '../../modules/api-client/vpc.ts'
import * as DnsGrpc from '../../modules/api-client/dns.ts'
import * as ComputeGrpc from '../../modules/api-client/compute.ts'
import * as KmsGrpc from '../../modules/api-client/kms.ts'
import * as IamGrpc from '../../modules/api-client/iam.ts'
import * as StorageGrpc from '../../modules/api-client/storage.ts'
import * as MysteryBoxGrpc from '../../modules/api-client/mysterybox.ts'

/** The harmless props change that forces reconcile without asking for any write. */
const FORCE = { 'live-echo': '1' }

const withLabels = (labels: Record<string, string> | undefined) => (labels === undefined ? {} : { labels })

/** The network's spec as JSON — the platform writes pool ids into it, so stability is the test. */
const networkSpec = (networkId: string) =>
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    return yield* specSnapshot(vpc.network.get(networkId))
  })

// ---------------------------------------------------------------------------
// vpc/v1 — network, subnet, route table, security group, rule, route, pool
// ---------------------------------------------------------------------------

const declareVpcFamily = (labels: Record<string, string> | undefined) =>
  Effect.gen(function* () {
    const network = yield* Nebius.vpc.Network('EchoVpc-Network', { ...withLabels(labels) })
    const subnet = yield* Nebius.vpc.Subnet('EchoVpc-Subnet', {
      networkId: network.id,
      ...withLabels(labels),
    })
    const routeTable = yield* Nebius.vpc.RouteTable('EchoVpc-RouteTable', {
      networkId: network.id,
      ...withLabels(labels),
    })
    const securityGroup = yield* Nebius.vpc.SecurityGroup('EchoVpc-SG', {
      networkId: network.id,
      ...withLabels(labels),
    })
    const securityRule = yield* Nebius.vpc.SecurityRule('EchoVpc-Rule', {
      parentId: securityGroup.id,
      direction: 'INGRESS',
      protocol: 'TCP',
      access: 'ALLOW',
      ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [443] },
      ...withLabels(labels),
    })
    const route = yield* Nebius.vpc.Route('EchoVpc-Route', {
      parentId: routeTable.id,
      destination: { cidr: '0.0.0.0/0' },
      nextHop: { defaultEgressGateway: true },
      ...withLabels(labels),
    })
    const pool = yield* Nebius.vpc.Pool('EchoVpc-Pool', {
      version: 'IPV4',
      visibility: 'PRIVATE',
      cidrs: [{ cidr: '10.0.0.0/24' }],
      ...withLabels(labels),
    })
    // `Allocation`'s drift list is a WHOLE-spec comparison — the pattern that has already produced
    // three live bugs — so it is audited alongside the rest of the family. A single /32 out of the
    // family's own pool is the cheapest real allocation.
    const allocation = yield* Nebius.vpc.Allocation('EchoVpc-Allocation', {
      ipv4Private: { cidr: '10.0.0.1/32', poolId: pool.id },
      ...withLabels(labels),
    })
    return { network, subnet, routeTable, securityGroup, securityRule, route, pool, allocation }
  })

integrationTest(
  test.provider,
  'live echo — vpc/v1 family: one write per create, and a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const vpc = yield* VpcGrpc.VpcGrpcService

      const created = yield* stack.deploy(declareVpcFamily(undefined))
      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'vpc/v1 Subnet', get: vpc.subnet.get(created.subnet.id) },
        { label: 'vpc/v1 RouteTable', get: vpc.routeTable.get(created.routeTable.id) },
        { label: 'vpc/v1 SecurityGroup', get: vpc.securityGroup.get(created.securityGroup.id) },
        { label: 'vpc/v1 SecurityRule', get: vpc.securityRule.get(created.securityRule.id) },
        { label: 'vpc/v1 Route', get: vpc.route.get(created.route.id) },
        { label: 'vpc/v1 Pool', get: vpc.pool.get(created.pool.id) },
        { label: 'vpc/v1 Allocation', get: vpc.allocation.get(created.allocation.id) },
      ]
      const calibrations = yield* calibrateCreates(targets)

      const networkBefore = yield* networkSpec(created.network.id)
      console.log(`LIVE-ECHO vpc/v1 Network: platform-owned spec=${networkBefore}`)

      yield* stack.deploy(declareVpcFamily(FORCE))

      yield* expectNoWrites(calibrations, targets)
      yield* expectSpecUnchanged('vpc/v1 Network', networkBefore, vpc.network.get(created.network.id))
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 420_000 },
)

// ---------------------------------------------------------------------------
// dns/v1 — zone + record
// ---------------------------------------------------------------------------

/**
 * The record has no `labels` and every other prop is compared and really written, so there is no
 * harmless prop change to force a reconcile with — its forced-reconcile probe is the
 * `ttl`-omission step of `tests/resources/dns/v1/record.integration.test.ts` (dropping `ttl` is a
 * props change `diff` ignores, so reconcile runs and must write nothing). Here it carries the
 * create-only assertion only.
 */
const declareDnsFamily = (force: boolean | undefined, negativeTtl = 60) =>
  Effect.gen(function* () {
    const network = yield* Nebius.vpc.Network('EchoDns-Network', { ...withLabels(force ? FORCE : undefined) })
    const zone = yield* Nebius.dns.Zone('EchoDns-Zone', {
      domainName: 'alchemy-echo.example.com.',
      vpc: { primaryNetworkId: network.id },
      soaSpec: { negativeTtl },
      ...withLabels(force ? FORCE : undefined),
    })
    const record = yield* Nebius.dns.Record('EchoDns-Record', {
      parentId: zone.id,
      relativeName: 'echo',
      type: 'A',
      data: '192.0.2.10',
      ttl: 300,
    })
    return { network, zone, record }
  })

integrationTest(
  test.provider,
  'live echo — dns/v1 family: one write per create, and a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const dns = yield* DnsGrpc.DnsGrpcService

      const created = yield* stack.deploy(declareDnsFamily(undefined))
      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'dns/v1 Zone', get: dns.zone.get(created.zone.id) },
        { label: 'dns/v1 Record', get: dns.record.get(created.record.id) },
      ]
      const calibrations = yield* calibrateCreates(targets)

      yield* stack.deploy(declareDnsFamily(true))

      // The record is re-declared with identical props (a `noop`), so only the zone is asserted
      // here; the record's own forced-reconcile evidence is the `ttl`-omission step linked above.
      yield* expectNoWrites(calibrations, [{ label: 'dns/v1 Zone', get: dns.zone.get(created.zone.id) }])

      // A REAL update settles two things at once: `zone.soaSpec.negativeTtl` converges in place
      // (a TASKS.md task-A assumption) and that this type's opaque version TRACKS writes — which is
      // what makes the forced-reconcile assertion above meaningful for a non-counter type.
      const beforeUpdate = yield* readVersion(dns.zone.get(created.zone.id))
      yield* stack.deploy(declareDnsFamily(true, 120))
      const afterUpdate = yield* readVersion(dns.zone.get(created.zone.id))
      const zoneSpec = JSON.stringify((yield* dns.zone.get(created.zone.id)).spec)
      console.log(`LIVE-ECHO dns/v1 Zone: version ${beforeUpdate} → ${afterUpdate} after a real negativeTtl update`)
      if (afterUpdate === beforeUpdate)
        return yield* Effect.fail(
          new Error(
            `LIVE-ECHO dns/v1 Zone: a real update did NOT move resourceVersion (${beforeUpdate}) — this type's\n` +
              `  version cannot witness writes, so the forced-reconcile assertion above is vacuous. Assert the spec\n` +
              `  echo instead (specSnapshot + expectSpecUnchanged) and update the NOT_A_WRITE_COUNTER entry.`,
          ),
        )
      if (!zoneSpec.includes('120'))
        return yield* Effect.fail(
          new Error(
            `LIVE-ECHO dns/v1 Zone: the negativeTtl update is not visible in the live spec: ${zoneSpec}`,
          ),
        )
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 420_000 },
)

// ---------------------------------------------------------------------------
// compute/v1 — disk, disk snapshot, filesystem, gpu cluster
// ---------------------------------------------------------------------------

const FABRIC_OVERRIDE = process.env.NEBIUS_TEST_INFINIBAND_FABRIC

/**
 * Discover a fabric the way a user would (the capacity advisor's advice for the project's region).
 * Its own `stack.deploy`: inside a deploy body an action resolves to an expression, so the value
 * can only be consumed here.
 */
const discoverFabric = (stack: Parameters<Parameters<typeof integrationTest>[2]>[0]) =>
  Effect.gen(function* () {
    if (FABRIC_OVERRIDE !== undefined) return FABRIC_OVERRIDE
    const region = yield* Config.String('NEBIUS_REGION').pipe(Config.withDefault('eu-north1'))
    const rows = yield* stack.deploy(Nebius.capacity.action.ListResourceAdvice({ region }))
    const fabric = rows.map((row) => row.fabric).find((candidate) => candidate !== '')
    if (fabric === undefined)
      return yield* Effect.fail(new Error(`no InfiniBand fabric advertised for region ${region}`))
    return fabric
  })

const declareComputeFamily = (labels: Record<string, string> | undefined, fabric: string) =>
  Effect.gen(function* () {
    const disk = yield* Nebius.compute.Disk('EchoDisk', {
      type: 'NETWORK_SSD',
      sizeGibibytes: 4,
      ...withLabels(labels),
    })
    const snapshot = yield* Nebius.compute.DiskSnapshot('EchoSnapshot', {
      sourceDiskId: disk.id,
      description: 'live-echo snapshot',
      ...withLabels(labels),
    })
    const filesystem = yield* Nebius.compute.Filesystem('EchoFilesystem', {
      type: 'NETWORK_SSD',
      sizeGibibytes: 4,
      ...withLabels(labels),
    })
    const gpuCluster = yield* Nebius.compute.GpuCluster('EchoGpuCluster', {
      infinibandFabric: fabric,
      ...withLabels(labels),
    })
    return { disk, snapshot, filesystem, gpuCluster }
  })

integrationTest(
  test.provider,
  'live echo — compute/v1 family: one write per create, and a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const compute = yield* ComputeGrpc.ComputeGrpcService
      const fabric = yield* discoverFabric(stack)

      const created = yield* stack.deploy(declareComputeFamily(undefined, fabric))

      // The attribute *type* contract, on real API data: these fields are int64 on the wire and
      // `toFriendlyAttributes` renders them as decimal strings, so the schemas type them `Schema.String`
      // (they were `Finite` — a type that lied). Pinned here as well as in the unit tests because this
      // is the path that produced the original observation.
      expect(typeof created.disk.sizeGibibytes).toBe('string')
      expect(typeof created.filesystem.blockSizeBytes).toBe('string')
      expect(typeof created.snapshot.contentSizeBytes).toBe('string')

      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'compute/v1 Disk', get: compute.disk.get(created.disk.id) },
        { label: 'compute/v1 DiskSnapshot', get: compute.diskSnapshot.get(created.snapshot.id) },
        { label: 'compute/v1 Filesystem', get: compute.filesystem.get(created.filesystem.id) },
        { label: 'compute/v1 GpuCluster', get: compute.gpuCluster.get(created.gpuCluster.id) },
      ]
      const calibrations = yield* calibrateCreates(targets)

      yield* stack.deploy(declareComputeFamily(FORCE, fabric))

      yield* expectNoWrites(calibrations, targets)
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 420_000 },
)



/** The tenant's default editors group — used as the membership parent (as the bindings test does). */
const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m'

/**
 * The whole IAM family in ONE deploy, with the service account created in the SAME deploy and
 * referenced through its in-effect instance (`sa.id`). That is the shape that used to fail: both
 * `StaticKey` and `AuthPublicKey` validated an id-valued prop inside `precreate`, which runs before
 * reference resolution, so the create died with `PropsValidationError: Expected string at
 * ["serviceAccountId"]` and the half-written state row blocked the destroy. `StaticKey` now creates
 * in `reconcile` (TASKS.md §F), and this test is the live pin for it.
 */
const declareIamFamily = (labels: Record<string, string> | undefined) =>
  Effect.gen(function* () {
    const sa = yield* Nebius.iam.ServiceAccount('EchoSA', {
      description: 'live-echo service account',
      ...withLabels(labels),
    })
    const group = yield* Nebius.iam.Group('EchoGroup', { ...withLabels(labels) })
    const membership = yield* Nebius.iam.GroupMembership('EchoMembership', {
      parentId: EDITORS_GROUP_ID as never,
      memberId: sa.id,
      ...withLabels(labels),
    })
    const accessKey = yield* Nebius.iam.AccessKey('EchoAccessKey', {
      serviceAccountId: sa.id,
      secretDeliveryMode: 'INLINE',
    })
    const authPublicKey = yield* Nebius.iam.AuthPublicKey('EchoAuthKey', {
      accountId: sa.id,
      data: RSA_4096_PUBLIC_KEY_A,
      description: 'live-echo auth key',
      ...withLabels(labels),
    })
    const staticKey = yield* Nebius.iam.StaticKey('EchoStaticKey', {
      serviceAccountId: sa.id,
      service: 'OBSERVABILITY',
    })
    return { sa, group, membership, accessKey, authPublicKey, staticKey }
  })

integrationTest(
  test.provider,
  'live echo — iam family: one write per create, and a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const iam = yield* IamGrpc.IamGrpcService

      const created = yield* stack.deploy(declareIamFamily(undefined))

      // `AccessKey` (v2) and `StaticKey` have no `labels` and no harmless prop change, so they carry
      // the create-only assertion only (`AccessKey` replaces on any spec change; the issue-only
      // `StaticKey` has no Update RPC at all).
      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'iam/v1 ServiceAccount', get: iam.serviceAccount.get(created.sa.id) },
        { label: 'iam/v1 Group', get: iam.group.get(created.group.id) },
        { label: 'iam/v1 GroupMembership', get: iam.groupMembership.get(created.membership.id) },
        { label: 'iam/v2 AccessKey', get: iam.accessKeyV2.get(created.accessKey.id) },
        { label: 'iam/v1 AuthPublicKey', get: iam.authPublicKey.get(created.authPublicKey.id) },
        { label: 'iam/v1 StaticKey', get: iam.staticKey.get(created.staticKey.id) },
      ]
      const calibrations = yield* calibrateCreates(targets)

      // IAM v1 metadata exposes NO `resourceVersion` (0 — measured 2026-09-22), so the version oracle
      // cannot witness these writes: the fallback is the spec echo. (AuthPublicKey does expose one,
      // so it gets both.)
      const snapshots = new Map<string, string>()
      for (const target of targets) snapshots.set(target.label, yield* specSnapshot(target.get))

      yield* stack.deploy(declareIamFamily(FORCE))

      const forceable = new Set([
        'iam/v1 ServiceAccount',
        'iam/v1 Group',
        'iam/v1 GroupMembership',
        'iam/v1 AuthPublicKey',
      ])
      yield* expectNoWrites(
        calibrations,
        targets.filter((target) => forceable.has(target.label)),
      )
      for (const target of targets) {
        const before = snapshots.get(target.label)
        if (before !== undefined) yield* expectSpecUnchanged(target.label, before, target.get)
      }
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 420_000 },
)

// ---------------------------------------------------------------------------
// storage/v1 — bucket (the transfer has its own update-path probe, and the objects
// in a bucket would block its delete, so this stays empty)
// ---------------------------------------------------------------------------

const bucketProps = {
  versioningPolicy: 'DISABLED',
  defaultStorageClass: 'STANDARD',
  objectAuditLogging: 'NONE',
  forceStorageClass: false,
} as const

const declareBucketFamily = (labels: Record<string, string> | undefined) =>
  Nebius.storage.Bucket('EchoBucket', { ...bucketProps, ...withLabels(labels) })

integrationTest(
  test.provider,
  'live echo — storage/v1 bucket: one write per create, and a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const storage = yield* StorageGrpc.StorageGrpcService

      const created = yield* stack.deploy(declareBucketFamily(undefined))
      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'storage/v1 Bucket', get: storage.bucket.get(created.id) },
      ]
      const calibrations = yield* calibrateCreates(targets)

      yield* stack.deploy(declareBucketFamily(FORCE))

      yield* expectNoWrites(calibrations, targets)
    }).pipe(
      safeDestroy(stack),
    ),
  // Delete is accepted immediately but reaped asynchronously (~6 min) — the test does not wait.
  { timeout: 420_000 },
)

// ---------------------------------------------------------------------------
// mysterybox/v1 — secret + secret version
// ---------------------------------------------------------------------------

const declareMysteryBoxFamily = (labels: Record<string, string> | undefined) =>
  Effect.gen(function* () {
    const secret = yield* Nebius.mysterybox.Secret('EchoSecret', {
      description: 'live-echo secret',
      payloads: [{ key: 'echo', stringValue: 'value' }],
      ...withLabels(labels),
    })
    const version = yield* Nebius.mysterybox.SecretVersion('EchoSecretVersion', {
      parentId: secret.id as never,
      description: 'live-echo version',
      payload: [{ key: 'echo', stringValue: 'value' }],
      ...withLabels(labels),
    })
    return { secret, version }
  })

integrationTest(
  test.provider,
  'live echo — mysterybox/v1 family: one write per create, and a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const mysterybox = yield* MysteryBoxGrpc.MysteryBoxGrpcService

      const created = yield* stack.deploy(declareMysteryBoxFamily(undefined))
      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'mysterybox/v1 Secret', get: mysterybox.secret.get(created.secret.id) },
        { label: 'mysterybox/v1 SecretVersion', get: mysterybox.secretVersion.get(created.version.id) },
      ]
      const calibrations = yield* calibrateCreates(targets)

      // Neither mysterybox resource exposes a `resourceVersion` (0 — measured 2026-09-22), so the
      // spec echo is the oracle.
      const snapshots = new Map<string, string>()
      for (const target of targets) snapshots.set(target.label, yield* specSnapshot(target.get))

      yield* stack.deploy(declareMysteryBoxFamily(FORCE))

      yield* expectNoWrites(calibrations, targets)
      for (const target of targets) {
        const before = snapshots.get(target.label)
        if (before !== undefined) yield* expectSpecUnchanged(target.label, before, target.get)
      }
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 420_000 },
)

// ---------------------------------------------------------------------------
// compute/v1 Image — its own family: an image needs a disk snapshot first, and the
// convergence sweep had previously found `cpuArchitecture`/`recommendedPlatforms`
// reaching neither `diff` nor the drift list.
// ---------------------------------------------------------------------------

const IMAGE_SOURCE_DISK = { type: 'NETWORK_SSD', sizeGibibytes: 4 } as const

/** Stage 2 keeps the disk+snapshot declared (a re-plan DELETES anything absent) and adds the image. */
const declareImageFamily = (labels: Record<string, string> | undefined) =>
  Effect.gen(function* () {
    const disk = yield* Nebius.compute.Disk('EchoImageSrc', { ...IMAGE_SOURCE_DISK, ...withLabels(labels) })
    const snapshot = yield* Nebius.compute.DiskSnapshot('EchoImageSnap', {
      sourceDiskId: disk.id,
      description: 'live-echo image source',
      ...withLabels(labels),
    })
    const image = yield* Nebius.compute.Image('EchoImage', {
      sourceDiskSnapshotId: snapshot.id,
      description: 'live-echo image',
      ...withLabels(labels),
    })
    return { disk, snapshot, image }
  })

integrationTest(
  test.provider,
  'live echo — compute/v1 Image: one write per create, and a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const compute = yield* ComputeGrpc.ComputeGrpcService

      // Stage 1: the disk alone, so the snapshot's source id is concrete state.
      yield* stack.deploy(Nebius.compute.Disk('EchoImageSrc', IMAGE_SOURCE_DISK))

      const created = yield* stack.deploy(declareImageFamily(undefined))
      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'compute/v1 Image', get: compute.image.get(created.image.id) },
      ]
      const calibrations = yield* calibrateCreates(targets)

      yield* stack.deploy(declareImageFamily(FORCE))

      yield* expectNoWrites(calibrations, targets)
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 600_000 },
)

// ---------------------------------------------------------------------------
// kms/v1 — symmetric + asymmetric key (int64 rotation period: the field class the
// int64-blind `deepEqual` hid, and a prime candidate for a materialized default)
// ---------------------------------------------------------------------------

const declareKmsFamily = (labels: Record<string, string> | undefined) =>
  Effect.gen(function* () {
    const symmetric = yield* Nebius.kms.SymmetricKey('EchoSymKey', {
      description: 'live-echo symmetric key',
      algorithm: 'AES_256',
      rotationPeriodSeconds: 2_592_000,
      ...withLabels(labels),
    })
    const asymmetric = yield* Nebius.kms.AsymmetricKey('EchoAsymKey', {
      description: 'live-echo asymmetric key',
      algorithm: 'ECDSA_NIST_P256_SHA_256',
      ...withLabels(labels),
    })
    return { symmetric, asymmetric }
  })

integrationTest(
  test.provider,
  'live echo — kms/v1 family: one write per create, and a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const kms = yield* KmsGrpc.KmsGrpcService

      const created = yield* stack.deploy(declareKmsFamily(undefined))
      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'kms/v1 SymmetricKey', get: kms.symmetricKey.get(created.symmetric.id) },
        { label: 'kms/v1 AsymmetricKey', get: kms.asymmetricKey.get(created.asymmetric.id) },
      ]
      // KMS exposes no `resourceVersion` (0), so the fallback oracle applies: the spec echo must be
      // unchanged after the forced reconcile.
      const calibrations = yield* calibrateCreates(targets)
      const symmetricBefore = yield* specSnapshot(kms.symmetricKey.get(created.symmetric.id))
      const asymmetricBefore = yield* specSnapshot(kms.asymmetricKey.get(created.asymmetric.id))

      yield* stack.deploy(declareKmsFamily(FORCE))

      yield* expectNoWrites(calibrations, targets)
      yield* expectSpecUnchanged('kms/v1 SymmetricKey', symmetricBefore, kms.symmetricKey.get(created.symmetric.id))
      yield* expectSpecUnchanged('kms/v1 AsymmetricKey', asymmetricBefore, kms.asymmetricKey.get(created.asymmetric.id))
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 420_000 },
)


// ---------------------------------------------------------------------------
// iam/v1 — federation, federation certificate, federated credentials
// ---------------------------------------------------------------------------

/**
 * Three resources whose drift lists compare the WHOLE spec (`specDeepEqual(live.spec, desired)`), which
 * is precisely the shape that broke twice already:
 *
 *   * `iam/v1/auth-public-key` — the API echoes the PEM one byte longer than it was sent (799 → 800),
 *     so the comparison could never match and every reconcile wrote;
 *   * `storage/v1/transfer` — the API never echoes `secretAccessKey` (write-only), and answers
 *     `limiters`/`interIterationInterval` with its own defaults.
 *
 * A federation certificate is a PEM of exactly that kind, the federation's SAML settings are the kind
 * of struct a platform fills defaults into, and `FederatedCredentials` carries a JWKS blob. All three
 * are cheap to create, so they belong in the audit.
 *
 * ⚠️ IAM metadata exposes **no `resourceVersion`** (measured 2026-09-22), so the *create-path*
 * double-write is not observable here — only the anti-loop direction (a forced reconcile must write
 * nothing), via the spec echo.
 */
const declareFederationFamily = (labels: Record<string, string> | undefined) =>
  Effect.gen(function* () {
    const federation = yield* Nebius.iam.Federation('EchoFederation', {
      samlSettings: {
        idpIssuer: 'https://echo-idp.example.com',
        ssoUrl: 'https://echo-idp.example.com/sso',
        forceAuthn: false,
      },
      userAccountAutoCreation: true,
      ...withLabels(labels),
    })
    const certificate = yield* Nebius.iam.FederationCertificate('EchoFederationCertificate', {
      parentId: federation.id,
      description: 'live-echo federation certificate',
      data: SELF_SIGNED_CERT,
      ...withLabels(labels),
    })
    const subject = yield* Nebius.iam.ServiceAccount('EchoFederationSubject', {
      description: 'live-echo federated subject',
      ...withLabels(labels),
    })
    const credentials = yield* Nebius.iam.FederatedCredentials('EchoFederatedCredentials', {
      oidcProvider: { issuerUrl: 'https://echo-oidc.example.com' },
      federatedSubjectId: 'live-echo-federated-subject',
      subjectId: subject.id,
      ...withLabels(labels),
    })
    return { federation, certificate, subject, credentials }
  })

integrationTest(
  test.provider,
  'live echo — iam/v1 federation family: a forced reconcile writes nothing',
  (stack) =>
    Effect.gen(function* () {
      const iam = yield* IamGrpc.IamGrpcService

      const created = yield* stack.deploy(declareFederationFamily(undefined))
      const targets: ReadonlyArray<LiveEchoTarget> = [
        { label: 'iam/v1 Federation', get: iam.federation.get(created.federation.id) },
        { label: 'iam/v1 FederationCertificate', get: iam.federationCertificate.get(created.certificate.id) },
        { label: 'iam/v1 FederatedCredentials', get: iam.federatedCredentials.get(created.credentials.id) },
      ]
      const calibrations = yield* calibrateCreates(targets)

      const snapshots = new Map<string, string>()
      for (const target of targets) snapshots.set(target.label, yield* specSnapshot(target.get))

      yield* stack.deploy(declareFederationFamily(FORCE))

      yield* expectNoWrites(calibrations, targets)
      for (const target of targets) {
        const before = snapshots.get(target.label)
        if (before !== undefined) yield* expectSpecUnchanged(target.label, before, target.get)
      }
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 420_000 },
)
