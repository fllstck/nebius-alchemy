import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusFederationCertSchema from '../../../../schemas/nebius/iam/v1/federation_certificate.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as FedCertSchema from './federation-certificate.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusFederationCertificate = Alchemy.Resource<
  'Nebius.iam.v1.FederationCertificate',
  FedCertSchema.FederationCertificateProps,
  FedCertSchema.FederationCertificateAttributes
>

export const NebiusFederationCertificate = Alchemy.Resource<NebiusFederationCertificate>(
  'Nebius.iam.v1.FederationCertificate',
)

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusFederationCertSchema.FederationCertificate,
): FedCertSchema.FederationCertificateAttributes =>
  ResourceUtils.toFriendlyAttributes<FedCertSchema.FederationCertificateAttributes>({
    rawResource: raw,
    resourceSchema: NebiusFederationCertSchema.FederationCertificate,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusFederationCertificateProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusFederationCertificate>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusFederationCertificate>, never, any>)
  : AlchemyProvider.succeed(NebiusFederationCertificate, {
  // FederationCertificate is a sub-resource of a Federation — nuke deletes
  // certificates before their federation.
  nuke: { dependsOn: ['Nebius.iam.v1.Federation'] },

  reconcile: Effect.fn('Nebius.iam.v1.FederationCertificate.reconcile')(function* ({ id, news, output, session }) {
    news = yield* FedCertSchema.validateFederationCertificateProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    let cert: NebiusFederationCertSchema.FederationCertificate | undefined
    if (output?.id) {
      cert = yield* iam.federationCertificate
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!cert) {
      const parentId = news.parentId
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.iam.v1.FederationCertificate (${name})`)
      cert = yield* iam.federationCertificate.create({
        metadata: { parentId, name, labels },
        spec: NebiusFederationCertSchema.FederationCertificateSpec.fromJSON({
          description: news.description || '',
          data: news.data,
        }),
      })
    }

    const desired = NebiusFederationCertSchema.FederationCertificateSpec.fromJSON({
      description: news.description || '',
      data: news.data,
    })
    if (cert.spec && !AlchemyDiff.deepEqual(cert.spec, desired)) {
      cert = yield* iam.federationCertificate.update({
        metadata: {
          id: cert.metadata!.id,
          resourceVersion: cert.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(cert)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.FederationCertificate',
    resourceLabel: 'FederationCertificate',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.federationCertificate.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v1.FederationCertificate',
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.federationCertificate.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // FederationCertificate is a sub-resource of a Federation — enumerate every
  // tenant federation and list its certificates.
  list: Effect.fn('Nebius.iam.v1.FederationCertificate.list')(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* Config.string('NEBIUS_TENANT_ID')
    const federations = yield* iam.federation.list(tenantId)
    const rows = yield* Effect.forEach(federations, (federation) =>
      iam.federationCertificate.listByFederation(federation.metadata!.id).pipe(
        Effect.map((certs) => certs.map((c) => toFriendlyAttributes(c))),
        Effect.catch(() => Effect.succeed([] as FedCertSchema.FederationCertificateAttributes[])),
      ),
    )
    return rows.flat()
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.FederationCertificate.diff')(function* ({ news, olds }) {
    news = news || ({} as FedCertSchema.FederationCertificateProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
