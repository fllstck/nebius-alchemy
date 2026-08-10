import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusFedCredsSchema from '../../../../schemas/nebius/iam/v1/federated_credentials.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as FedCredsSchema from './federated-credentials.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusFederatedCredentials = Alchemy.Resource<
  'Nebius.iam.v1.FederatedCredentials',
  FedCredsSchema.FederatedCredentialsProps,
  FedCredsSchema.FederatedCredentialsAttributes
>

export const NebiusFederatedCredentials = Alchemy.Resource<NebiusFederatedCredentials>(
  'Nebius.iam.v1.FederatedCredentials',
)

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusFedCredsSchema.FederatedCredentials,
): FedCredsSchema.FederatedCredentialsAttributes =>
  ResourceUtils.toFriendlyAttributes<FedCredsSchema.FederatedCredentialsAttributes>({
    rawResource: raw,
    resourceSchema: NebiusFedCredsSchema.FederatedCredentials,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusFederatedCredentialsProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusFederatedCredentials>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusFederatedCredentials>, never, any>)
  : AlchemyProvider.succeed(NebiusFederatedCredentials, {
  // Federated credentials belong to a ServiceAccount — nuke deletes them
  // before their SA.
  nuke: { dependsOn: ['Nebius.iam.v1.ServiceAccount'] },

  reconcile: Effect.fn('Nebius.iam.v1.FederatedCredentials.reconcile')(function* ({ id, news, output, session }) {
    news = yield* FedCredsSchema.validateFederatedCredentialsProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    let creds: NebiusFedCredsSchema.FederatedCredentials | undefined
    if (output?.id) {
      creds = yield* iam.federatedCredentials
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!creds) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.iam.v1.FederatedCredentials (${name})`)
      creds = yield* iam.federatedCredentials.create({
        metadata: { parentId, name, labels },
        spec: NebiusFedCredsSchema.FederatedCredentialsSpec.fromJSON({
          oidcProvider: {
            issuerUrl: news.oidcProvider.issuerUrl,
            ...(news.oidcProvider.jwkSetJson ? { jwkSetJson: news.oidcProvider.jwkSetJson } : {}),
          },
          federatedSubjectId: news.federatedSubjectId,
          subjectId: news.subjectId,
        }),
      })
    }

    const desired = NebiusFedCredsSchema.FederatedCredentialsSpec.fromJSON({
      oidcProvider: {
        issuerUrl: news.oidcProvider.issuerUrl,
        ...(news.oidcProvider.jwkSetJson ? { jwkSetJson: news.oidcProvider.jwkSetJson } : {}),
      },
      federatedSubjectId: news.federatedSubjectId,
      subjectId: news.subjectId,
    })
    if (creds.spec && !AlchemyDiff.deepEqual(creds.spec, desired)) {
      yield* session.note(`Updating Nebius.iam.v1.FederatedCredentials (${creds.metadata!.name})`)
      creds = yield* iam.federatedCredentials.update({
        metadata: {
          id: creds.metadata!.id,
          resourceVersion: creds.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(creds)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.FederatedCredentials',
    resourceLabel: 'FederatedCredentials',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.federatedCredentials.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v1.FederatedCredentials',
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.federatedCredentials.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.iam.v1.FederatedCredentials',
    service: IamGrpc.IamGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (project) => project.metadata!.id,
    listByParent: (svc, parentId) => svc.federatedCredentials.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.FederatedCredentials.diff')(function* ({ news, olds }) {
    news = news || ({} as FedCredsSchema.FederatedCredentialsProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
