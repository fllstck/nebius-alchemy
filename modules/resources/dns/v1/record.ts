import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusRecordSchema from '../../../../schemas/nebius/dns/v1/record.ts'
import * as DnsGrpc from '../../../api-client/dns.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as RecordSchema from './record.schema.ts'
import * as Factory from '../../factory.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

// ----- RESOURCE TYPES

export type NebiusRecord = Alchemy.Resource<
  'Nebius.dns.v1.Record',
  RecordSchema.RecordProps,
  RecordSchema.RecordAttributes
>

export const NebiusRecord = Alchemy.Resource<NebiusRecord>('Nebius.dns.v1.Record')

// ----- HELPERS

const toFriendlyAttributes = (rawRecord: NebiusRecordSchema.Record): RecordSchema.RecordAttributes =>
  ResourceUtils.toFriendlyAttributes<RecordSchema.RecordAttributes>({
    rawResource: rawRecord,
    resourceSchema: NebiusRecordSchema.Record,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusRecordProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusRecord>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusRecord>, never, any>)
  : AlchemyProvider.succeed(NebiusRecord, {
  // Records are children of a Zone — nuke deletes records before their zone.
  nuke: { dependsOn: ['Nebius.dns.v1.Zone'] },

  // ⚠️ Non-standard: parent is Zone, not Project
  reconcile: Effect.fn('Nebius.dns.v1.Record.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* RecordSchema.validateRecordProps(news)

    const dnsGrpcService = yield* DnsGrpc.DnsGrpcService

    // 1. Observe
    let record: NebiusRecordSchema.Record | undefined
    if (output?.id) {
      record = yield* dnsGrpcService.record
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — parent is zone, not project; name is auto-generated from relativeName
    if (!record) {
      const name = `${news.relativeName}-${news.type}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      yield* session.note(`Creating Nebius.dns.v1.Record (${name})`)
      record = yield* dnsGrpcService.record.create({
        metadata: { parentId: news.parentId, name, labels: internalLabels },
        spec: NebiusRecordSchema.RecordSpec.fromJSON(news),
      })
    }

    // 3. Sync
    const desired = NebiusRecordSchema.RecordSpec.fromJSON(news)
    if (
      record.spec &&
      (record.spec.data !== desired.data ||
        !AlchemyDiff.deepEqual(record.spec.ttl, desired.ttl) ||
        record.spec.deletionProtection !== desired.deletionProtection)
    ) {
      yield* session.note(`Updating Nebius.dns.v1.Record (${record.metadata!.name})`)
      record = yield* dnsGrpcService.record.update({
        metadata: {
          id: record.metadata!.id,
          resourceVersion: record.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(record)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.dns.v1.Record',
    resourceLabel: 'Record',
    service: DnsGrpc.DnsGrpcService,
    deleteById: (svc, id) => svc.record.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.dns.v1.Record',
    service: DnsGrpc.DnsGrpcService,
    getById: (svc, id) => svc.record.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // Records are children of a Zone (no project-scoped list) — enumerate every
  // zone in the tenant and list each zone's records. Without this, nuke can't
  // delete records before their zone (Nebius does not cascade-delete), so zone
  // deletes would fail or orphan records.
  list: Effect.fn('Nebius.dns.v1.Record.list')(function* () {
    const dns = yield* DnsGrpc.DnsGrpcService
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    const projects = yield* iam.project.list(tenantId)
    const rows = yield* Effect.forEach(projects, (project) =>
      dns.zone.list(project.metadata!.id).pipe(
        Effect.flatMap((zones) =>
          Effect.forEach(zones, (zone) =>
            dns.record.list(zone.metadata!.id).pipe(
              Effect.map((records) => records.map((r) => toFriendlyAttributes(r))),
              Effect.catch(() => Effect.succeed([] as RecordSchema.RecordAttributes[])),
            ),
          ),
        ),
        Effect.map((nested) => nested.flat()),
        Effect.catch(() => Effect.succeed([] as RecordSchema.RecordAttributes[])),
      ),
    )
    return rows.flat()
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.dns.v1.Record.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Zone change requires replace (can't move records between zones)
    if (news.parentId !== olds?.parentId) return { action: 'replace' }
    // Type change requires replace
    if (news.type !== olds?.type) return { action: 'replace' }

    return undefined
  }),
})
