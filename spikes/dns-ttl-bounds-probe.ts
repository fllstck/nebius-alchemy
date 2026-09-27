/**
 * What TTL values does `dns/v1 Record` actually accept? (2026-09-24)
 *
 * The last open item of the validation audit: `Record.ttl` is a bare `Schema.Finite`, while the platform
 * clearly enforces something — an earlier probe saw `7d` accepted and `30d`/`365d` rejected with HTTP 400.
 * The proto adds a second, quieter rule worth checking: *"If absent or negative, will be assumed to be the
 * default value (600)"* — i.e. a **negative** TTL may be accepted and silently replaced, which is the
 * class this package turns into a plan-time error (the same shape as the zone's `soaSpec.negativeTtl ≥ 5`
 * filter, whose rationale is "fail fast rather than accept a value the platform discards").
 *
 * One throwaway zone (seconds; no VM) and one record per TTL, each read back so a silently-substituted
 * value is visible rather than inferred. The zone is deleted at the end, which cascades its records.
 *
 *   bun spikes/dns-ttl-bounds-probe.ts
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
import * as VpcGrpcModule from '../modules/api-client/vpc.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as NebiusRecordSchema from '../schemas/nebius/dns/v1/record.ts'
import * as NebiusZoneSchema from '../schemas/nebius/dns/v1/zone.ts'
import { requireProjectId } from './spike-env.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { DnsGrpcService, DnsGrpcServiceLive } = DnsGrpcModule
const { VpcGrpcService, VpcGrpcServiceLive } = VpcGrpcModule
const { RecordSpec } = NebiusRecordSchema
const { ZoneSpec } = NebiusZoneSchema
/**
 * The zone's auto-created authority records. Both are undeletable by design (measured: deleting either is
 * refused with `9 FAILED_PRECONDITION: VPC Zones do not support delegation, so deleting <TYPE> Records is not
 * allowed`), and neither blocks the zone's own delete — which is what the earlier failure was: SQL… no, my
 * **probe's** records were the blockers, one type at a time.
 */
const UNDELETABLE = new Set([
  NebiusRecordSchema.RecordSpec_RecordType.NS,
  NebiusRecordSchema.RecordSpec_RecordType.SOA,
]) as ReadonlySet<number>

const PROJECT_ID = requireProjectId()
const ZONE_NAME = 'alchemy-dns-ttl-probe'
const DOMAIN = 'alchemy-ttl-probe.example.com.'

/**
 * Arms, and what each one is for:
 *  * `-1`/`0` — the proto's "absent or negative ⇒ 600", measured by *reading the value back* (an accepted value
 *    that comes back different is the silent no-op this package fails fast on);
 *  * `0.5` — the wire field is an int64, so a fractional second is silently truncated or rounded;
 *  * the upper half brackets the rejection the earlier probe reported between 7d and 30d, and then walks
 *    past `INT32_MAX` to see whether any upper bound exists at all.
 */
const TTLS = [-1, 0, 0.5, 1, 5, 600, 604800, 2592000, 31536000, 2147483647, 2147483648, 4294967295] as const

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

const stamp = () => new Date().toISOString().slice(11, 19)

const program = Effect.gen(function* () {
  const dns = yield* DnsGrpcService
  const vpc = yield* VpcGrpcService

  const zones = (yield* dns.zone.list(PROJECT_ID)).filter((z) => z.metadata?.name === ZONE_NAME)
  if (zones.length > 0) {
    // Idempotent start: a zone that still holds records cannot be deleted (measured: `9 FAILED_PRECONDITION:
    // Zone … is not empty`), so clean up in the right order rather than aborting and needing a second tool.
    for (const leftover of zones) {
      const leftoverId = leftover.metadata!.id
      for (const record of yield* dns.record.list(leftoverId)) {
        // Skip the zone's own authority records: a VPC zone always carries them, deleting either is refused
        // (see `UNDELETABLE`), and they do not block the zone delete below.
        if (UNDELETABLE.has(record.spec?.type ?? -1)) continue
        yield* dns.record.delete(record.metadata!.id)
      }
      yield* dns.zone.delete(leftoverId)
      console.log(`cleaned up leftover zone ${leftoverId}`)
    }
    yield* Effect.sleep('5 seconds')
  }
  const networks = yield* vpc.network.list(PROJECT_ID)
  const networkId = networks[0]?.metadata?.id
  if (networkId === undefined) {
    console.error('ABORT — no network in the project to scope the zone to.')
    return
  }
  console.log(`zone ${DOMAIN} in network ${networkId} (${networks[0]?.metadata?.name})`)

  const zone = yield* dns.zone.create({
    metadata: { parentId: PROJECT_ID, name: ZONE_NAME },
    spec: ZoneSpec.fromJSON({ domainName: DOMAIN, vpc: { primaryNetworkId: networkId } }),
  })
  const zoneId = zone.metadata!.id
  console.log(`[${stamp()}] zone created: ${zoneId}\n`)

  console.log('ttl (s)    result                    spec.ttl read back')
  console.log('---------  ------------------------  -----------------')
  for (const ttl of TTLS) {
    const relativeName = `probe-t${ttl < 0 ? `neg${Math.abs(ttl)}` : ttl}`
    const created = yield* dns.record
      .create({
        metadata: { parentId: zoneId, name: relativeName },
        spec: RecordSpec.fromJSON({ relativeName, type: 'A', ttl, data: '10.0.0.1' }),
      })
      .pipe(
        Effect.map((record) => ({ kind: 'accepted' as const, record })),
        Effect.catch((error) => Effect.succeed({ kind: 'rejected' as const, message: String(error).slice(0, 120) })),
      )

    if (created.kind === 'rejected') {
      console.log(`${String(ttl).padEnd(9)}  REJECTED: ${created.message}`)
      continue
    }
    const readBack = yield* dns.record.get(created.record.metadata!.id)
    const echoed = readBack.spec?.ttl?.toString() ?? '(absent)'
    const silently = echoed !== String(ttl) ? `  ← SILENTLY ${echoed}` : ''
    console.log(`${String(ttl).padEnd(9)}  accepted                  ${echoed}${silently}`)
  }

  // Cleanup — a zone cannot be deleted while it holds *user* records, so those go first; the auto-created NS
  // record stays (deleting it is refused) and does not block the zone delete.
  let deleted = 0
  for (const record of yield* dns.record.list(zoneId)) {
    if (UNDELETABLE.has(record.spec?.type ?? -1)) continue
    yield* dns.record.delete(record.metadata!.id)
    deleted += 1
  }
  console.log(`deleted ${deleted} probe records (the zone's own NS/SOA records are left in place)`)
  yield* dns.zone.delete(zoneId)
  yield* Effect.sleep('5 seconds')
  const remaining = (yield* dns.zone.list(PROJECT_ID)).filter((z) => z.metadata?.name === ZONE_NAME)
  console.log(`\n[${stamp()}] POSTFLIGHT: probe zones remaining = ${remaining.length}`)
})

const transports = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)
const layer = Layer.mergeAll(
  DnsGrpcServiceLive.pipe(Layer.provide(transports)),
  VpcGrpcServiceLive.pipe(Layer.provide(transports)),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
