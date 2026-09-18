import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusZoneSchema from '../../../../schemas/nebius/dns/v1/zone.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as DnsGrpc from '../../../api-client/dns.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as ZoneSchema from './zone.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusZone = Alchemy.Resource<'Nebius.dns.v1.Zone', ZoneSchema.ZoneProps, ZoneSchema.ZoneAttributes>

export const NebiusZone = Alchemy.Resource<NebiusZone>('Nebius.dns.v1.Zone')

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
  reconcile: Effect.fn('Nebius.dns.v1.Zone.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}
    news = yield* ZoneSchema.validateZoneProps(news)

    const dnsGrpcService = yield* DnsGrpc.DnsGrpcService

    // 1. Observe
    let zone: NebiusZoneSchema.Zone | undefined
    if (output?.id) {
      zone = yield* dnsGrpcService.zone
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure
    if (!zone) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.dns.v1.Zone (${name})`)
      zone = yield* dnsGrpcService.zone.create({
        metadata: { parentId, name, labels },
        spec: NebiusZoneSchema.ZoneSpec.fromJSON(news),
      })
    }

    // 3. Sync — VPC scope and SOA settings can change (domainName is immutable)
    const desired = NebiusZoneSchema.ZoneSpec.fromJSON(news)
    if (
      zone.spec &&
      (!AlchemyDiff.deepEqual(zone.spec.vpc, desired.vpc) ||
        // SOA is opt-in: the API answers with its own SOA when none was set, so
        // comparing an absent prop against it would update on every reconcile.
        (news.soaSpec !== undefined && !AlchemyDiff.deepEqual(zone.spec.soaSpec, desired.soaSpec)))
    ) {
      yield* session.note(`Updating Nebius.dns.v1.Zone (${zone.metadata!.name})`)
      zone = yield* dnsGrpcService.zone.update({
        metadata: {
          id: zone.metadata!.id,
          resourceVersion: zone.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(zone)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.dns.v1.Zone',
    resourceLabel: 'Zone',
    service: DnsGrpc.DnsGrpcService,
    deleteById: (svc, id) => svc.zone.delete(id),
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

  // eslint-disable-next-line require-yield
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
