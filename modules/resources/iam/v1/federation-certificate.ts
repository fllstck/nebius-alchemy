import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusFederationCertSchema from '../../../../schemas/nebius/iam/v1/federation_certificate.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as FedCertSchema from './federation-certificate.schema.ts'
import * as Factory from '../../factory.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

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

    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!cert) {
      const parentId = news.parentId
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
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
    // Compare ONLY `description` — the one mutable field.
    //
    // ⚠️ Live behaviour, probed 2026-09-22: the API does not echo `data` verbatim — it terminates the
    // PEM (1240 bytes sent, **1241** echoed: exactly a trailing `\n` after `-----END CERTIFICATE-----`),
    // so the previous whole-spec `specDeepEqual` differed on every read and wrote an update on EVERY
    // reconcile (`resourceVersion` 1 → 2 across a labels-only reconcile). Same normalization, and the
    // same fix, as `iam/v1 AuthPublicKey` (799 → 800).
    //
    // Nothing is lost: `data` is immutable, and `diff` now plans a REPLACE for a change to it, so it
    // never reaches this update path.
    if (cert.spec && (cert.spec.description ?? '') !== (news.description ?? '')) {
      cert = yield* iam.federationCertificate.update({
        metadata: {
          id: cert.metadata!.id,
          resourceVersion: cert.metadata!.resourceVersion.toString(),
          labels,
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
    validate: FedCertSchema.validateFederationCertificateProps,
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.federationCertificate.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // FederationCertificate is a sub-resource of a Federation — enumerate every
  // tenant federation and list its certificates.
  list: Effect.fn('Nebius.iam.v1.FederationCertificate.list')(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
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

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* FedCertSchema.validateFederationCertificateProps(news)
    // `data` is immutable after creation (the schema says so, and the API normalizes whatever it
    // echoes — see the drift-list comment), so a change is a REPLACE. Without this the change planned
    // an `update` that the drift list then declined to write, i.e. the change was silently dropped.
    if (news.data !== olds?.data) return Factory.replaceKeepingName(news)
    return Factory.identityChangeRequiresReplace(news, olds)
  }),
})
