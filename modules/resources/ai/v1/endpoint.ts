import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusEndpointSchema from '../../../../schemas/nebius/ai/v1/endpoint.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as AiGrpc from '../../../api-client/ai.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as EndpointSchema from './endpoint.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusEndpoint = Alchemy.Resource<
  'Nebius.ai.v1.Endpoint',
  EndpointSchema.EndpointProps,
  EndpointSchema.EndpointAttributes
>

export const NebiusEndpoint = Alchemy.Resource<NebiusEndpoint>('Nebius.ai.v1.Endpoint')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusEndpointSchema.Endpoint} (metadata + spec +
 * status) into {@link EndpointSchema.EndpointAttributes}.
 */
const toFriendlyAttributes = (rawEndpoint: NebiusEndpointSchema.Endpoint): EndpointSchema.EndpointAttributes =>
  ResourceUtils.toFriendlyAttributes<EndpointSchema.EndpointAttributes>({
    rawResource: rawEndpoint,
    resourceSchema: NebiusEndpointSchema.Endpoint,
  })

// ----- PROVIDER

export const NebiusEndpointProvider = AlchemyProvider.succeed(NebiusEndpoint, {
  // Observe → Ensure → Return (no Sync: the AI API has no update RPC)
  reconcile: Effect.fn('Nebius.ai.v1.Endpoint.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}

    // Validate user input at runtime
    news = yield* EndpointSchema.validateEndpointProps(news)

    const aiGrpcService = yield* AiGrpc.AiGrpcService

    // 1. Observe — fetch live state if we have a cached physical ID
    let endpoint: NebiusEndpointSchema.Endpoint | undefined
    if (output?.id) {
      endpoint = yield* aiGrpcService.endpoint
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
    if (!endpoint) {
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.ai.v1.Endpoint (${name})`)
      endpoint = yield* aiGrpcService.endpoint
        .create({
          metadata: { parentId, name, labels },
          // Specs carry enum fields (port protocol, volume mount mode, disk
          // type) — fromJSON maps enum strings to int32, fromPartial would
          // pass them through and serialize NaN.
          spec: NebiusEndpointSchema.EndpointSpec.fromJSON(news),
        })
        .pipe(
          // Create can time out client-side while the backend still starts the
          // endpoint (the long-running operation is created server-side before
          // the response reaches us). Recover by looking the endpoint up by its
          // deterministic physical name and adopting it — otherwise destroy has
          // no ID to act on and silently leaks a running workload.
          Effect.catch((e: unknown) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(
                `Nebius.ai.v1.Endpoint create failed — attempting recovery: ${String(e)}`,
              )
              const recovered = yield* aiGrpcService.endpoint
                .getByName({ parentId, name })
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (recovered) {
                yield* session.note(
                  `Recovered Nebius.ai.v1.Endpoint (${recovered.metadata!.id}) after create failure`,
                )
                return recovered
              }
              return yield* Effect.fail(e)
            }),
          ),
        )
    }

    // 3. Return — fresh Attributes
    return toFriendlyAttributes(endpoint)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.ai.v1.Endpoint',
    resourceLabel: 'Endpoint',
    service: AiGrpc.AiGrpcService,
    deleteById: (svc, id) => svc.endpoint.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.ai.v1.Endpoint',
    service: AiGrpc.AiGrpcService,
    getById: (svc, id) => svc.endpoint.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.ai.v1.Endpoint',
    service: AiGrpc.AiGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.endpoint.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // No update RPC → labels deliberately drift; any other spec change (or a
  // name change) requires replacing the resource.
  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.ai.v1.Endpoint.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    const newsWithoutLabels: Record<string, unknown> = { ...news }
    delete newsWithoutLabels.labels
    const oldsWithoutLabels: Record<string, unknown> = { ...olds }
    delete oldsWithoutLabels.labels

    return (
      Factory.nameChangeRequiresReplace(news, olds) ??
      (AlchemyDiff.deepEqual(newsWithoutLabels, oldsWithoutLabels) ? undefined : { action: 'replace' })
    )
  }),
})
