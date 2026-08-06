import * as Effect from 'effect/Effect'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusRecordSchema from '../../../../schemas/nebius/dns/v1/record.ts'
import * as DnsGrpc from '../../../api-client/dns.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as RecordSchema from './record.schema.ts'
import * as Factory from '../../factory.ts'

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

export const NebiusRecordProvider = AlchemyProvider.succeed(NebiusRecord, {
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

  // ⚠️ Non-standard: no project-scoped list (parent is Zone)
  list: Effect.fn('Nebius.dns.v1.Record.list')(function* () {
    yield* Effect.void
    return []
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
