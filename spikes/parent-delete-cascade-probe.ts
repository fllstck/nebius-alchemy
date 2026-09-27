/**
 * Does deleting a parent take its children with it? (R-22)
 *
 * Eight providers justify a `nuke: { dependsOn: [...] }` ordering with the same sentence — *"Nebius
 * does not cascade-delete associated resources"* — and the repo asserts the **opposite** in it
 * maintenance helper:
 *
 *   | where | claim |
 *   | `iam/v1 static-key.ts`, `auth-public-key.ts`, `iam/v2 access-key.ts`, `access-permit.ts`, `group-membership.ts`, `vpc/v1 security-rule.ts`, `route.ts`, `dns/v1 record.ts` | "does not cascade-delete associated resources" → children must be deleted first |
 *   | `Factory.makeCrudDelete` (on treating `NOT_FOUND` as success) | "it may have been cascaded away by the server, **e.g. deleting a service account removes its group memberships and access keys**" |
 *   | `mk8s/v1 Cluster` (measured 2026-09-23) | the delete **cascades** to node groups, instances and disks |
 *   | `iam/v1 StaticKey` (measured 2026-09-25, `spikes/static-key-parent-probe.ts`) | the SA delete **cascaded** the key |
 *
 * Neither side was measured. That matters more than a comment-accuracy question: `dependsOn` only
 * works for a child nuke can *enumerate*. Where a child's `list` is blind (as StaticKey's was until
 * R-21), the cascade is the only thing between the tenant and a leaked long-lived credential — so
 * "does the parent delete take the child?" is the reading that says whether a blind list leaks or not.
 *
 * One scenario per relation, each in a fresh parent, and three possible readings:
 *
 *   CASCADED — the parent delete succeeded and the child is gone (`get` answers `NOT_FOUND`).
 *   ORPHANED — the parent delete succeeded and the child is still there. The claim is true; the
 *              `dependsOn` is load-bearing, and a blind list would leak here.
 *   REFUSED  — the parent delete failed while the child existed (`FAILED_PRECONDITION` / not-empty).
 *              The ordering is required by the API itself, which is the strongest version of the claim.
 *
 * The first scenario is a **positive control**: StaticKey → ServiceAccount is already measured as a
 * cascade (R-21), so if this harness reports anything else for it, the harness is what is broken.
 *
 * ## Readings, 2026-09-25 (two full runs, identical; `POSTFLIGHT nothing left` both times)
 *
 *   CASCADED — `ServiceAccount` → `StaticKey` (control) · `AuthPublicKey` · `iam/v2 AccessKey` ·
 *              `GroupMembership` (by *member* reference) · `Group` → `GroupMembership` · `AccessPermit`
 *   REFUSED  — `SecurityGroup` → `SecurityRule` · `RouteTable` → `Route` · `Zone` → `Record`
 *   ORPHANED — none
 *
 * So the sentence that eight providers used to justify their ordering was false for the IAM family
 * (those deletes cascade), wrong about the mechanism for the VPC/DNS family (the API refuses, naming
 * the child, rather than cascading or orphaning), and `Factory.makeCrudDelete`'s
 * "deleting a service account removes its group memberships and access keys" is literally true. The
 * table lives in AGENTS.md §"Delete cascades — measured, not assumed".
 *
 * Re-running is cheap (no VMs: two service accounts, a group, a network, a security group, a route
 * table, a zone and six children) and safe on refusals too — the teardown deletes children before
 * parents, re-checks existence so a cascaded object is not re-deleted, and reports survivors rather
 * than assuming none.
 *
 *   bun spikes/parent-delete-cascade-probe.ts
 */

import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as DnsGrpcModule from '../modules/api-client/dns.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as IamGrpcModule from '../modules/api-client/iam.ts'
import * as VpcGrpcModule from '../modules/api-client/vpc.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as AccessSchema from '../schemas/nebius/iam/v1/access.ts'
import * as AccessPermitSchema from '../schemas/nebius/iam/v1/access_permit.ts'
import * as AuthPublicKeySchema from '../schemas/nebius/iam/v1/auth_public_key.ts'
import * as GroupSchema from '../schemas/nebius/iam/v1/group.ts'
import * as GroupMembershipSchema from '../schemas/nebius/iam/v1/group_membership.ts'
import * as StaticKeySchema from '../schemas/nebius/iam/v1/static_key.ts'
import * as AccessKeyV2Schema from '../schemas/nebius/iam/v2/access_key.ts'
import * as DnsRecordSchema from '../schemas/nebius/dns/v1/record.ts'
import * as DnsZoneSchema from '../schemas/nebius/dns/v1/zone.ts'
import * as NetworkSchema from '../schemas/nebius/vpc/v1/network.ts'
import * as RouteSchema from '../schemas/nebius/vpc/v1/route.ts'
import * as RouteTableSchema from '../schemas/nebius/vpc/v1/route_table.ts'
import * as SecurityGroupSchema from '../schemas/nebius/vpc/v1/security_group.ts'
import * as SecurityRuleSchema from '../schemas/nebius/vpc/v1/security_rule.ts'
import { RSA_4096_PUBLIC_KEY_A } from '../tests/helpers/fixtures.ts'
import { requireProjectId } from './spike-env.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { IamGrpcService, IamGrpcServiceLive } = IamGrpcModule
const { VpcGrpcService, VpcGrpcServiceLive } = VpcGrpcModule
const { DnsGrpcService, DnsGrpcServiceLive } = DnsGrpcModule
const { NebiusGrpcTransportLive } = GrpcTransportModule

// R-23: read from the environment, never a committed default.
const PROJECT_ID = requireProjectId()

const RUN = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()
const PREFIX = 'alchemy-cascade-probe'
const unique = (base: string) => `${PREFIX}-${base}-${RUN}`.slice(0, 62)

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (label: string, value?: unknown) =>
  console.log(`[${stamp()}] ${label}${value === undefined ? '' : `: ${typeof value === 'string' ? value : JSON.stringify(value)}`}`)

const account = (serviceAccountId: string) =>
  AccessSchema.Account.fromPartial({ serviceAccount: { id: serviceAccountId } })

const authLayer = Layer.mergeAll(ProfileStoreLive, NebiusAuthModule.NebiusAuth).pipe(
  Layer.provide(CredentialsStoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      PlatformNode.NodeServices.layer,
      SaTokenModule.SaTokenMinterLive,
      SaBootstrapModule.SaBootstrapLive,
    ),
  ),
)

interface Tracked {
  readonly label: string
  readonly id: string
  readonly exists: (id: string) => Effect.Effect<boolean, unknown>
  readonly remove: (id: string) => Effect.Effect<void, unknown>
}

interface Ctx {
  readonly tracked: Array<Tracked>
  readonly log: (label: string, value?: unknown) => void
}

/**
 * `get` → "is it still there?". `NOT_FOUND` is the only code that means *gone*; anything else is
 * reported instead of being folded into `false`, because "this child could not be read" and "this
 * child does not exist" must not be the same answer in a probe whose whole output is that distinction.
 */
const existsVia =
  (get: (id: string) => Effect.Effect<unknown, unknown>, label: string) =>
  (id: string): Effect.Effect<boolean, unknown> =>
    get(id).pipe(
      Effect.map(() => true),
      Effect.catch((error) =>
        Effect.sync(() => {
          if ((error as { code?: number }).code === 5) return false
          log(`  ! ${label} read failed — treating as PRESENT (not as gone)`, String(error).slice(0, 220))
          return true
        }),
      ),
    )

interface Scenario {
  readonly label: string
  /** The comment(s) this reading settles. */
  readonly claim: string
  readonly createParent: (ctx: Ctx) => Effect.Effect<string, unknown>
  readonly createChild: (ctx: Ctx, parentId: string) => Effect.Effect<string, unknown>
  readonly deleteParent: (id: string) => Effect.Effect<void, unknown>
}

const program = Effect.gen(function* () {
  const iam = yield* IamGrpcService
  const vpc = yield* VpcGrpcService
  const dns = yield* DnsGrpcService

  const tracked: Array<Tracked> = []
  const ctx: Ctx = { tracked, log }
  const track = (entry: Tracked): string => {
    tracked.push(entry)
    return entry.id
  }

  // ── Shared scaffolding ───────────────────────────────────────────────────
  // A VPC network, needed by the security-group, route-table and zone arms. Created up front and
  // deleted last so every arm can reuse it.
  const network = yield* vpc.network.create({
    metadata: { parentId: PROJECT_ID, name: unique('net') },
    spec: NetworkSchema.NetworkSpec.fromJSON({}),
  })
  const networkId = track({
    label: 'vpc/v1 Network (scaffold)',
    id: network.metadata!.id,
    exists: existsVia((id) => vpc.network.get(id), 'network'),
    remove: (id) => vpc.network.delete(id),
  })
  log('scaffolding', { networkId })

  const serviceAccount = (ctx: Ctx, purpose: string) =>
    Effect.gen(function* () {
      const sa = yield* iam.serviceAccount.create({
        metadata: { parentId: PROJECT_ID, name: unique(`sa-${purpose}`) },
        spec: {},
      })
      return track({
        label: `iam/v1 ServiceAccount (${purpose})`,
        id: sa.metadata!.id,
        exists: existsVia((id) => iam.serviceAccount.get(id), 'service account'),
        remove: (id) => iam.serviceAccount.delete(id),
      })
    })

  const group = (ctx: Ctx, purpose: string) =>
    Effect.gen(function* () {
      const created = yield* iam.group.create({
        metadata: { parentId: PROJECT_ID, name: unique(`grp-${purpose}`) },
        spec: GroupSchema.GroupSpec.fromPartial({}),
      })
      return track({
        label: `iam/v1 Group (${purpose})`,
        id: created.metadata!.id,
        exists: existsVia((id) => iam.group.get(id), 'group'),
        remove: (id) => iam.group.delete(id),
      })
    })

  // ── Scenarios ────────────────────────────────────────────────────────────
  const scenarios: ReadonlyArray<Scenario> = [
    {
      label: 'ServiceAccount → StaticKey (POSITIVE CONTROL: R-21 measured a cascade)',
      claim: 'iam/v1 static-key.ts "does not cascade-delete associated resources"',
      createParent: (c) => serviceAccount(c, 'sk'),
      createChild: (c, saId) =>
        Effect.gen(function* () {
          const issued = yield* iam.staticKey.issue({
            // The container is the PROJECT; the account is `spec.account` (R-21).
            metadata: { parentId: PROJECT_ID, name: unique('key') },
            spec: StaticKeySchema.StaticKeySpec.fromJSON({ account: account(saId), service: 'OBSERVABILITY' }),
          })
          return track({
            label: 'iam/v1 StaticKey',
            id: issued.key.metadata!.id,
            exists: existsVia((id) => iam.staticKey.get(id), 'static key'),
            remove: (id) => iam.staticKey.delete(id),
          })
        }),
      deleteParent: (id) => iam.serviceAccount.delete(id),
    },
    {
      label: 'ServiceAccount → AuthPublicKey',
      claim: 'iam/v1 auth-public-key.ts "Nebius does not cascade-delete associated resources"',
      createParent: (c) => serviceAccount(c, 'apk'),
      createChild: (c, saId) =>
        Effect.gen(function* () {
          const key = yield* iam.authPublicKey.create({
            metadata: { parentId: PROJECT_ID, name: unique('apk') },
            spec: AuthPublicKeySchema.AuthPublicKeySpec.fromJSON({
              account: account(saId),
              data: RSA_4096_PUBLIC_KEY_A,
            }),
          })
          return track({
            label: 'iam/v1 AuthPublicKey',
            id: key.metadata!.id,
            exists: existsVia((id) => iam.authPublicKey.get(id), 'auth public key'),
            remove: (id) => iam.authPublicKey.delete(id),
          })
        }),
      deleteParent: (id) => iam.serviceAccount.delete(id),
    },
    {
      label: 'ServiceAccount → AccessKey (iam/v2)',
      claim: 'iam/v2 access-key.ts "Nebius does not cascade-delete associated resources"',
      createParent: (c) => serviceAccount(c, 'ak'),
      createChild: (c, saId) =>
        Effect.gen(function* () {
          const key = yield* iam.accessKeyV2.create({
            metadata: { parentId: PROJECT_ID, name: unique('ak') },
            spec: AccessKeyV2Schema.AccessKeySpec.fromJSON({
              account: account(saId),
              secretDeliveryMode: 'INLINE',
            }),
          })
          return track({
            label: 'iam/v2 AccessKey',
            id: key.metadata!.id,
            exists: existsVia((id) => iam.accessKeyV2.get(id), 'access key'),
            remove: (id) => iam.accessKeyV2.delete(id),
          })
        }),
      deleteParent: (id) => iam.serviceAccount.delete(id),
    },
    {
      label: 'Group → GroupMembership',
      claim: 'iam/v1 group-membership.ts "nuke deletes memberships before their group"',
      createParent: (c) => group(c, 'gm'),
      createChild: (c, groupId) =>
        Effect.gen(function* () {
          const member = yield* serviceAccount(c, 'gm-member')
          const membership = yield* iam.groupMembership.create({
            // The API rejects `metadata.name` for group memberships.
            metadata: { parentId: groupId },
            spec: GroupMembershipSchema.GroupMembershipSpec.fromPartial({ memberId: member }),
          })
          return track({
            label: 'iam/v1 GroupMembership',
            id: membership.metadata!.id,
            exists: existsVia((id) => iam.groupMembership.get(id), 'group membership'),
            remove: (id) => iam.groupMembership.delete(id),
          })
        }),
      deleteParent: (id) => iam.group.delete(id),
    },
    {
      label: 'ServiceAccount → GroupMembership (member reference, not the metadata parent)',
      claim: 'Factory.makeCrudDelete "deleting a service account removes its group memberships"',
      createParent: (c) => serviceAccount(c, 'gm2'),
      createChild: (c, saId) =>
        Effect.gen(function* () {
          const container = yield* group(c, 'gm2')
          const membership = yield* iam.groupMembership.create({
            metadata: { parentId: container },
            spec: GroupMembershipSchema.GroupMembershipSpec.fromPartial({ memberId: saId }),
          })
          return track({
            label: 'iam/v1 GroupMembership (member = the parent SA)',
            id: membership.metadata!.id,
            exists: existsVia((id) => iam.groupMembership.get(id), 'group membership'),
            remove: (id) => iam.groupMembership.delete(id),
          })
        }),
      deleteParent: (id) => iam.serviceAccount.delete(id),
    },
    {
      label: 'Group → AccessPermit',
      claim: 'iam/v1 access-permit.ts "nuke deletes permits before their group"',
      createParent: (c) => group(c, 'ap'),
      createChild: (c, groupId) =>
        Effect.gen(function* () {
          const permit = yield* iam.accessPermit.create({
            // The API rejects `metadata.name` on AccessPermit creates.
            metadata: { parentId: groupId },
            spec: AccessPermitSchema.AccessPermitSpec.fromJSON({ resourceId: PROJECT_ID, role: 'viewer' }),
          })
          return track({
            label: 'iam/v1 AccessPermit',
            id: permit.metadata!.id,
            exists: existsVia((id) => iam.accessPermit.get(id), 'access permit'),
            remove: (id) => iam.accessPermit.delete(id),
          })
        }),
      deleteParent: (id) => iam.group.delete(id),
    },
    {
      label: 'SecurityGroup → SecurityRule',
      claim: 'vpc/v1 security-rule.ts "nuke deletes rules before their group"',
      createParent: (c) =>
        Effect.gen(function* () {
          const sg = yield* vpc.securityGroup.create({
            metadata: { parentId: PROJECT_ID, name: unique('sg') },
            spec: SecurityGroupSchema.SecurityGroupSpec.fromJSON({ networkId }),
          })
          return track({
            label: 'vpc/v1 SecurityGroup',
            id: sg.metadata!.id,
            exists: existsVia((id) => vpc.securityGroup.get(id), 'security group'),
            remove: (id) => vpc.securityGroup.delete(id),
          })
        }),
      createChild: (c, sgId) =>
        Effect.gen(function* () {
          const rule = yield* vpc.securityRule.create({
            metadata: { parentId: sgId, name: unique('rule') },
            spec: SecurityRuleSchema.SecurityRuleSpec.fromJSON({
              access: 'ALLOW',
              protocol: 'ANY',
              type: 'STATEFUL',
              priority: 500,
              ingress: { sourceCidrs: ['10.0.0.0/8'] },
            }),
          })
          return track({
            label: 'vpc/v1 SecurityRule',
            id: rule.metadata!.id,
            exists: existsVia((id) => vpc.securityRule.get(id), 'security rule'),
            remove: (id) => vpc.securityRule.delete(id),
          })
        }),
      deleteParent: (id) => vpc.securityGroup.delete(id),
    },
    {
      label: 'RouteTable → Route',
      claim: 'vpc/v1 route.ts "nuke deletes routes before their table"',
      createParent: (c) =>
        Effect.gen(function* () {
          const table = yield* vpc.routeTable.create({
            metadata: { parentId: PROJECT_ID, name: unique('rt') },
            spec: RouteTableSchema.RouteTableSpec.fromJSON({ networkId }),
          })
          return track({
            label: 'vpc/v1 RouteTable',
            id: table.metadata!.id,
            exists: existsVia((id) => vpc.routeTable.get(id), 'route table'),
            remove: (id) => vpc.routeTable.delete(id),
          })
        }),
      createChild: (c, tableId) =>
        Effect.gen(function* () {
          const route = yield* vpc.route.create({
            metadata: { parentId: tableId, name: unique('route') },
            spec: RouteSchema.RouteSpec.fromJSON({
              // `0.0.0.0/0` — a default egress gateway rejects any destination inside RFC1918
              // (`3 INVALID_ARGUMENT: Destination cidr … for default egress gateway must not be within
              // RFC1918 ranges`, hit with 10.99.0.0/24 on the first run of this probe).
              destination: { cidr: '0.0.0.0/0' },
              nextHop: { defaultEgressGateway: true },
            }),
          })
          return track({
            label: 'vpc/v1 Route',
            id: route.metadata!.id,
            exists: existsVia((id) => vpc.route.get(id), 'route'),
            remove: (id) => vpc.route.delete(id),
          })
        }),
      deleteParent: (id) => vpc.routeTable.delete(id),
    },
    {
      label: 'DNS Zone → Record',
      claim: 'dns/v1 record.ts "nuke deletes records before their zone"',
      createParent: (c) =>
        Effect.gen(function* () {
          const zone = yield* dns.zone.create({
            metadata: { parentId: PROJECT_ID, name: unique('zone') },
            spec: DnsZoneSchema.ZoneSpec.fromJSON({
              domainName: `${unique('zone')}.example.com.`,
              vpc: { primaryNetworkId: networkId },
            }),
          })
          return track({
            label: 'dns/v1 Zone',
            id: zone.metadata!.id,
            exists: existsVia((id) => dns.zone.get(id), 'zone'),
            remove: (id) => dns.zone.delete(id),
          })
        }),
      createChild: (c, zoneId) =>
        Effect.gen(function* () {
          const record = yield* dns.record.create({
            metadata: { parentId: zoneId, name: unique('rec') },
            spec: DnsRecordSchema.RecordSpec.fromJSON({
              relativeName: 'www',
              type: 'A',
              ttl: 600,
              data: '10.0.0.1',
            }),
          })
          return track({
            label: 'dns/v1 Record',
            id: record.metadata!.id,
            exists: existsVia((id) => dns.record.get(id), 'record'),
            remove: (id) => dns.record.delete(id),
          })
        }),
      deleteParent: (id) => dns.zone.delete(id),
    },
  ]

  const readings: Array<{ relation: string; reading: string; detail: string }> = []

  const runScenario = (scenario: Scenario) =>
    Effect.gen(function* () {
      const parentId = yield* scenario.createParent(ctx)
      const childId = yield* scenario.createChild(ctx, parentId)
      const child = tracked.find((t) => t.id === childId)!

      // The measurement: delete the PARENT while the child exists.
      const deleteError = yield* scenario
        .deleteParent(parentId)
        .pipe(
          Effect.map(() => undefined),
          Effect.catch((error) => Effect.succeed(String(error).slice(0, 280))),
        )

      let reading: string
      let detail = ''
      if (deleteError !== undefined) {
        reading = 'REFUSED'
        detail = deleteError
      } else {
        // The parent delete is operation-backed and already polled; give replication a moment.
        yield* Effect.sleep('4 seconds')
        const alive = yield* child.exists(childId)
        reading = alive ? 'ORPHANED' : 'CASCADED'
      }

      readings.push({ relation: scenario.label, reading, detail })
      log(`${scenario.label} → ${reading}${detail ? ` (${detail})` : ''}`)
      log(`   settles: ${scenario.claim}`)
    }).pipe(
      Effect.timeout('120 seconds'),
      // A timeout or a failed setup must not abort the remaining relations — record and continue.
      Effect.catch((error) =>
        Effect.sync(() => {
          readings.push({ relation: scenario.label, reading: 'INCONCLUSIVE', detail: String(error).slice(0, 280) })
          log(`${scenario.label} → INCONCLUSIVE`, String(error).slice(0, 280))
        }),
      ),
    )

  yield* Effect.gen(function* () {
    for (const scenario of scenarios) {
      yield* runScenario(scenario)
    }

    log('READINGS', readings)
    const byReading = (kind: string) => readings.filter((r) => r.reading === kind).map((r) => r.relation)
    log('SUMMARY', {
      CASCADED: byReading('CASCADED'),
      ORPHANED: byReading('ORPHANED'),
      REFUSED: byReading('REFUSED'),
      INCONCLUSIVE: byReading('INCONCLUSIVE'),
    })
  }).pipe(
    // Guaranteed teardown, reverse creation order: children before their parents, scaffolding last.
    // Every object is re-checked first, so an object the cascade already removed is not re-deleted.
    Effect.ensuring(
      Effect.gen(function* () {
        for (const entry of [...tracked].reverse()) {
          const alive = yield* entry.exists(entry.id).pipe(Effect.catch(() => Effect.succeed(true)))
          if (!alive) continue
          yield* entry.remove(entry.id).pipe(
            Effect.map(() => log('cleanup — removed', `${entry.label} ${entry.id}`)),
            Effect.catch((error) =>
              Effect.sync(() => log('cleanup FAILED — delete by hand', `${entry.label} ${entry.id}: ${String(error).slice(0, 200)}`)),
            ),
          )
        }
        yield* Effect.sleep('3 seconds')
        const survivors: string[] = []
        for (const entry of tracked) {
          const alive = yield* entry.exists(entry.id).pipe(Effect.catch(() => Effect.succeed(true)))
          if (alive) survivors.push(`${entry.label} ${entry.id}`)
        }
        log('POSTFLIGHT', survivors.length === 0 ? 'nothing left' : { SURVIVORS: survivors })
      }),
    ),
  )
})

const credentialsLayer = fromAuthProvider.pipe(Layer.provide(authLayer))
const transportLayer = NebiusGrpcTransportLive.pipe(Layer.provide(credentialsLayer))
const iamLayer = IamGrpcServiceLive.pipe(Layer.provide(transportLayer))
const vpcLayer = VpcGrpcServiceLive.pipe(Layer.provide(transportLayer))
const dnsLayer = DnsGrpcServiceLive.pipe(Layer.provide(transportLayer))
const programLayer = Layer.mergeAll(iamLayer, vpcLayer, dnsLayer, credentialsLayer, transportLayer)

try {
  await Effect.runPromise(program.pipe(Effect.provide(programLayer), Effect.scoped))
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
