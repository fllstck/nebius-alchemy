import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusEndpointSchema from '../../../../schemas/nebius/ai/v1/endpoint.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as AiGrpc from '../../../api-client/ai.ts'
import type { GrpcDeadlineExceededError, GrpcError } from '../../../api-client/grpc-utils.ts'
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

// ----- Readiness (O1 resolution: fresh creates wait for RUNNING)

/** Poll interval while waiting for the endpoint VM to reach RUNNING. */
const READY_POLL_INTERVAL_MS = 10_000
/** Fresh creates wait at most this long for RUNNING (matches the 20-min operation poll budget). */
const READY_DEADLINE_MS = 20 * 60 * 1000

/** A freshly-created endpoint's VM failed to reach RUNNING (or entered ERROR) in time. */
export class EndpointNotReady extends Schema.TaggedErrorClass<EndpointNotReady>()('EndpointNotReady', {
  id: Schema.String,
  state: Schema.String,
  message: Schema.String,
}) {}

/**
 * Poll a freshly-created endpoint until its state is RUNNING — i.e.
 * `publicEndpoints` is populated. The binding's deploy-time env derivation
 * reads `publicEndpoints` at apply time, so the resource isn't ready until
 * the VM is up: a create that returned while PROVISIONING would otherwise
 * fail the worker's env evaluation with EndpointNotRunning (the AI_BINDINGS
 * O1 hit). Existing endpoints are NOT awaited — a STOPPED endpoint should
 * fail fast via the binding, not hang the deploy for the full deadline.
 */
const waitUntilRunning = Effect.fn('Nebius.ai.v1.Endpoint.waitUntilRunning')(function* (
  endpointId: string,
): Effect.fn.Return<
  NebiusEndpointSchema.Endpoint,
  GrpcError | GrpcDeadlineExceededError | EndpointNotReady,
  AiGrpc.AiGrpcService
> {
  const aiGrpcService = yield* AiGrpc.AiGrpcService
  const started = yield* Clock.currentTimeMillis
  for (;;) {
    const current = yield* aiGrpcService.endpoint.get(endpointId)
    const state = toFriendlyAttributes(current).state
    if (state === 'RUNNING') return current
    if (state === 'ERROR') {
      return yield* new EndpointNotReady({
        id: endpointId,
        state,
        message: `Endpoint ${endpointId} entered ERROR while waiting for RUNNING`,
      })
    }
    const elapsed = (yield* Clock.currentTimeMillis) - started
    if (elapsed > READY_DEADLINE_MS) {
      return yield* new EndpointNotReady({
        id: endpointId,
        state,
        message: `Endpoint ${endpointId} did not reach RUNNING within 20 minutes (state: ${state})`,
      })
    }
    yield* Effect.sleep(READY_POLL_INTERVAL_MS)
  }
})

// ----- PROVIDER

// ----- PROVIDER

/**
 * D8 bundle-safety guard (mirrors `resources/storage/v1/bucket.ts`): a
 * Worker importing the resource construct for registration never invokes the
 * provider, but the module-scope `AlchemyProvider.succeed(...)` call keeps the
 * whole deploy graph (gRPC clients, protobuf schemas, factory helpers) alive
 * in Worker bundles. The bundler's `__ALCHEMY_RUNTIME__` fold turns this into
 * `undefined` at build time and DCEs the branch + its imports. At deploy time
 * the flag is undefined and the real provider is registered.
 */
export const NebiusEndpointProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusEndpoint>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusEndpoint>, never, any>)
  : AlchemyProvider.succeed(NebiusEndpoint, {
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

    // 2. Ensure — create if missing (with ownership tags). `isFresh` marks
    // creates in THIS deploy (vs adopted/observed endpoints) — see step 2.5.
    const isFresh = endpoint === undefined
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

    // 2.5 — Readiness: the binding's env derivation reads publicEndpoints at
    // apply time, so the resource isn't ready until the VM is up
    // (AI_BINDINGS.md O1 resolution). Fresh/transient endpoints are awaited
    // to RUNNING; an observed ERROR is a real container failure — fail with a
    // clear message instead of binding an empty URL; STOPPED endpoints bind
    // '' and fail fast at runtime (EndpointNotRunning) rather than hanging
    // the deploy.
    const readyState = toFriendlyAttributes(endpoint).state
    if (readyState === 'ERROR') {
      return yield* new EndpointNotReady({
        id: endpoint.metadata!.id,
        state: readyState,
        message: `Endpoint ${endpoint.metadata!.id} is in ERROR state — check its logs/state details in the Nebius console, then fix or replace it`,
      })
    }
    if (isFresh || readyState === 'PROVISIONING' || readyState === 'STARTING' || readyState === 'IMAGE_PULLING') {
      endpoint = yield* waitUntilRunning(endpoint.metadata!.id)
    }

    // 3. Return — fresh Attributes. `authToken` is a one-time value (like the
    // AccessKey secret): the API never echoes it back, so synthesize it from
    // props — which Alchemy state persists across deploys — to keep it
    // readable off the resource handle (bindings rely on this, AI_BINDINGS.md
    // AD1). read/list paths have no `news` and omit it (documented).
    return {
      ...toFriendlyAttributes(endpoint),
      authToken: news.authToken,
    }
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
