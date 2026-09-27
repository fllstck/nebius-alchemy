import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'

import * as NebiusZoneSchema from '../../../../schemas/nebius/dns/v1/zone.ts'
import * as NebiusRecordSchema from '../../../../schemas/nebius/dns/v1/record.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as DnsGrpc from '../../../api-client/dns.ts'
import * as GrpcUtils from '../../../api-client/grpc-utils.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as ZoneSchema from './zone.schema.ts'
import * as Factory from '../../factory.ts'
import { getOrUndefined } from '../../shared/not-found.ts'

// ----- RESOURCE TYPES

export type NebiusZone = Alchemy.Resource<'Nebius.dns.v1.Zone', ZoneSchema.ZoneProps, ZoneSchema.ZoneAttributes>

export const NebiusZone = Alchemy.Resource<NebiusZone>('Nebius.dns.v1.Zone')

/**
 * The zone's own authority records: every VPC zone carries them, deleting either is refused, and neither
 * blocks the zone's own delete (measured 2026-09-24 — see the `delete` lifecycle below).
 */
const AUTHORITY_RECORD_TYPES: ReadonlySet<number> = new Set([
  NebiusRecordSchema.RecordSpec_RecordType.NS,
  NebiusRecordSchema.RecordSpec_RecordType.SOA,
])

// ----- HELPERS

const toFriendlyAttributes = (rawZone: NebiusZoneSchema.Zone): ZoneSchema.ZoneAttributes =>
  ResourceUtils.toFriendlyAttributes<ZoneSchema.ZoneAttributes>({
    rawResource: rawZone,
    resourceSchema: NebiusZoneSchema.Zone,
    overrides: { state: 'READY' },
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusZoneProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusZone>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusZone>, never, any>)
  : AlchemyProvider.succeed(NebiusZone, {
  reconcile: Effect.fn('Nebius.dns.v1.Zone.reconcile')(function* ({ id, news, output, session, olds }) {
    news = news || {}
    news = yield* ZoneSchema.validateZoneProps(news)

    const dnsGrpcService = yield* DnsGrpc.DnsGrpcService

    // 1. Observe
    let zone: NebiusZoneSchema.Zone | undefined
    if (output?.id) {
      zone = yield* getOrUndefined(dnsGrpcService.zone.get(output.id))
    }

    // 2. Ensure
    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!zone) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      yield* session.note(`Creating Nebius.dns.v1.Zone (${name})`)
      zone = yield* dnsGrpcService.zone.create({
        metadata: { parentId, name, labels },
        spec: NebiusZoneSchema.ZoneSpec.fromJSON(news),
      })
    }

    // 3. Sync — VPC scope and SOA settings can change (domainName is immutable)
    const desired = NebiusZoneSchema.ZoneSpec.fromJSON(news)
    if ((

      zone.spec &&
      (!ResourceUtils.specDeepEqual(zone.spec.vpc, desired.vpc) ||
        // SOA is opt-in: the API answers with its own SOA when none was set, so
        // comparing an absent prop against it would update on every reconcile.
        // Same reasoning one level down for its only field: `negativeTtl` is optional
        // in props but a non-optional int64 on the wire (an omitted value encodes as
        // 0, which the API replaces with its own default) — the comparison is only
        // meaningful for a TTL the user actually pinned.
        //
        // `negativeTtl` is a `Long`, so the comparison itself must go through
        // `specDeepEqual`: with plain `deepEqual` two different TTLs compared equal
        // and the change never converged.
        (news.soaSpec?.negativeTtl !== undefined &&
          !ResourceUtils.specDeepEqual(zone.spec.soaSpec, desired.soaSpec)))
    
    ) ||
    Factory.labelsDrifted(zone.metadata?.labels, news.labels, olds?.labels)) {
      yield* session.note(`Updating Nebius.dns.v1.Zone (${zone.metadata!.name})`)
      zone = yield* dnsGrpcService.zone.update({
        metadata: {
          id: zone.metadata!.id,
          resourceVersion: zone.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(zone)
  }),

  /**
   * Delete the zone — after making sure it is actually empty.
   *
   * Not `makeCrudDelete`: that helper treats `9 FAILED_PRECONDITION` as "a dependent is still tearing down"
   * and re-issues the delete every 20 s for ~4 minutes, so a zone holding out-of-band records would fail late
   * and without naming anything. The precondition is knowable through the API in one call, so it is checked
   * here and reported as {@link ZoneSchema.ZoneNotEmpty} — see that error for the full reasoning.
   *
   * The zone's own **NS and SOA** records are skipped: every VPC zone carries them, they cannot be deleted
   * (`9 FAILED_PRECONDITION: VPC Zones do not support delegation, so deleting NS Records is not allowed`),
   * and they do **not** block the zone's delete (measured live 2026-09-24,
   * `spikes/dns-ttl-bounds-probe.ts` — its cleanup hit all three of those facts in that order).
   */
  delete: Effect.fn('Nebius.dns.v1.Zone.delete')(function* ({ output, session }) {
    if (!output?.id) return
    const dnsGrpcService = yield* DnsGrpc.DnsGrpcService

    // Idempotent: NOT_FOUND means it is already gone (a re-run destroy reaches here).
    const current = yield* getOrUndefined(dnsGrpcService.zone.get(output.id))
    if (!current) return

    const records = (yield* dnsGrpcService.record.list(output.id)).filter(
      (record) => !AUTHORITY_RECORD_TYPES.has(record.spec?.type ?? -1),
    )
    if (records.length > 0) {
      const named = records.map((record) => {
        const name = record.spec?.relativeName || record.metadata?.name || record.metadata?.id || '?'
        const type = record.spec?.type === undefined ? '?' : NebiusRecordSchema.recordSpec_RecordTypeToJSON(record.spec.type)
        return `${name} (${type})`
      })
      const zoneName = current.metadata?.name ?? output.id
      return yield* new ZoneSchema.ZoneNotEmpty({
        zoneId: output.id,
        zoneName,
        records: named,
        message: [
          `Zone ${zoneName} still holds ${records.length} record(s): ${named.join(', ')}.`,
          'A zone cannot be deleted while it has user records — the API answers `Zone … is not empty`.',
          'Records declared in this stack are deleted before their zone, so these are out-of-band (console, script, another stack) or their own delete failed.',
          'Delete them (or remove them from the configuration that owns them) and re-run the destroy.',
        ].join(' '),
      })
    }

    yield* session.note(`Deleting Nebius.dns.v1.Zone (${current.metadata?.name ?? output.id})`)
    yield* Factory.runDeleteWithProgress({
      label: 'Zone',
      id: output.id,
      deleteOnce: dnsGrpcService.zone.delete(output.id).pipe(
        Effect.catchIf(
          (e: unknown): e is GrpcUtils.GrpcError => e instanceof GrpcUtils.GrpcError && e.code === 5,
          () => Effect.void,
        ),
      ),
      session,
    })
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.dns.v1.Zone',
    validate: ZoneSchema.validateZoneProps,
    service: DnsGrpc.DnsGrpcService,
    getById: (svc, id) => svc.zone.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.dns.v1.Zone',
    service: DnsGrpc.DnsGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.zone.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  diff: Effect.fn('Nebius.dns.v1.Zone.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* ZoneSchema.validateZoneProps(news)

    // Domain name is immutable — changing it requires replace. The name change
    // (below) is create-first: a different domain means a different resource.
    if (news.domainName !== olds?.domainName) return Factory.replaceKeepingName(news)
    // Name change requires replace
    if (Factory.identityChangeRequiresReplace(news, olds)) return { action: 'replace' }

    return undefined
  }),
})
