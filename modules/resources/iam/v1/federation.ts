import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusFederationSchema from '../../../../schemas/nebius/iam/v1/federation'
import * as IamGrpc from '../../../api-client/iam'
import * as ResourceUtils from '../../utilities.ts'

import * as FederationSchema from './federation.schema.ts'
import * as Factory from '../../factory.ts'

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

export const NebiusFederationProvider = AlchemyProvider.succeed(NebiusFederation, {
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
      const parentId = news.parentId || (yield* Config.string('NEBIUS_TENANT_ID'))
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
    if (federation.spec && !AlchemyDiff.deepEqual(federation.spec, desired)) {
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

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.Federation',
    resourceLabel: 'Federation',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.federation.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v1.Federation',
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.federation.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Effect.fn('Nebius.iam.v1.Federation.list')(function* () {
    const svc = yield* IamGrpc.IamGrpcService
    const tenantId = yield* Config.string('NEBIUS_TENANT_ID')
    const items = yield* svc.federation.list(tenantId)
    return items.map(toFriendlyAttributes)
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.Federation.diff')(function* ({ news, olds }) {
    news = news || ({} as FederationSchema.FederationProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
