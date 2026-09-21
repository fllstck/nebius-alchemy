import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusFederationSchema from '../../../../schemas/nebius/iam/v1/federation.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as FederationSchema from './federation.schema.ts'
import * as Factory from '../../factory.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

// ----- RESOURCE TYPES

export type NebiusFederation = Alchemy.Resource<
  'Nebius.iam.v1.Federation',
  FederationSchema.FederationProps,
  FederationSchema.FederationAttributes
>

export const NebiusFederation = Alchemy.Resource<NebiusFederation>('Nebius.iam.v1.Federation')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusFederationSchema.Federation,
): FederationSchema.FederationAttributes =>
  ResourceUtils.toFriendlyAttributes<FederationSchema.FederationAttributes>({
    rawResource: raw,
    resourceSchema: NebiusFederationSchema.Federation,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusFederationProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusFederation>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusFederation>, never, any>)
  : AlchemyProvider.succeed(NebiusFederation, {
  reconcile: Effect.fn('Nebius.iam.v1.Federation.reconcile')(function* ({ id, news, output, session }) {
    news = yield* FederationSchema.validateFederationProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    let federation: NebiusFederationSchema.Federation | undefined
    if (output?.id) {
      federation = yield* iam.federation
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!federation) {
      const parentId = news.parentId || (yield* resolveTenantId())
      const name = news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.iam.v1.Federation (${name})`)
      federation = yield* iam.federation.create({
        metadata: { parentId, name, labels },
        spec: NebiusFederationSchema.FederationSpec.fromJSON({
          userAccountAutoCreation: news.userAccountAutoCreation ?? false,
          samlSettings: {
            idpIssuer: news.samlSettings.idpIssuer,
            ssoUrl: news.samlSettings.ssoUrl,
            forceAuthn: news.samlSettings.forceAuthn ?? false,
          },
        }),
      })
    }

    const desired = NebiusFederationSchema.FederationSpec.fromJSON({
      userAccountAutoCreation: news.userAccountAutoCreation ?? false,
      samlSettings: {
        idpIssuer: news.samlSettings.idpIssuer,
        ssoUrl: news.samlSettings.ssoUrl,
        forceAuthn: news.samlSettings.forceAuthn ?? false,
      },
    })
    if (federation.spec && !ResourceUtils.specDeepEqual(federation.spec, desired)) {
      yield* session.note(`Updating Nebius.iam.v1.Federation (${federation.metadata!.name})`)
      federation = yield* iam.federation.update({
        metadata: {
          id: federation.metadata!.id,
          resourceVersion: federation.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(federation)
  }),

  // oxlint-disable-next-line typescript/no-explicit-any — approved: Alchemy Session type not exported
  delete: Effect.fn('Nebius.iam.v1.Federation.delete')(function* ({ output, session }: { output: { id: string }; session: any }) {
    const iam = yield* IamGrpc.IamGrpcService

    // An ACTIVE federation cannot be deleted — deactivate it first
    // (see `nebius iam federation delete` docs). NOT_FOUND means the
    // federation is already gone; treat that as success and skip delete.
    yield* session.note(`Deactivating Nebius.iam.v1.Federation (${output.id})`)
    yield* iam.federation.deactivate(output.id).pipe(
      Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.void : Effect.fail(e))),
    )

    yield* session.note(`Deleting Federation (${output.id})`)
    yield* iam.federation.delete(output.id)
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v1.Federation',
    validate: FederationSchema.validateFederationProps,
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.federation.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Effect.fn('Nebius.iam.v1.Federation.list')(function* () {
    const svc = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    const items = yield* svc.federation.list(tenantId)
    return items.map(toFriendlyAttributes)
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.Federation.diff')(function* ({ news, olds }) {
    news = news || ({} as FederationSchema.FederationProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* FederationSchema.validateFederationProps(news)
    return Factory.identityChangeRequiresReplace(news, olds)
  }),
})
