/**
 * Shared helpers for behavioral unit tests of resource providers.
 *
 * Every resource module exports its provider as a layer (built via
 * `AlchemyProvider.succeed`) and its resource class (which carries the typed
 * `Provider` tag). `resolveProvider` builds the provider service in-process so
 * tests can invoke lifecycle operations — most importantly `diff`, which is
 * pure for every Nebius resource — without any network or cloud access.
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { Provider, ProviderService } from 'alchemy/Provider'
import type { ResourceLike } from 'alchemy/Resource'

import { fakeSession } from './mocks.ts'

/**
 * Resolve the provider service from a module's exported layer + resource tag.
 *
 *   const svc = await resolveProvider(
 *     BucketModule.NebiusBucket.Provider,
 *     BucketModule.NebiusBucketProvider,
 *   )
 */
export const resolveProvider = async <R extends ResourceLike>(
  provider: Provider<R>,
  // Exported provider layers carry `any` requirements captured by Effect.fn;
  // the layer is only provided, never inspected.
  // oxlint-disable-next-line no-explicit-any
  layer: Layer.Layer<Provider<R>, never, any>,
): Promise<ProviderService<R>> => {
  return runEffect(
    Effect.gen(function* () {
      return yield* provider
    }).pipe(Effect.provide(layer)),
  )
}

/**
 * Run an Effect whose environment TypeScript can't prove empty (e.g. schemas'
 * `decodeUnknownEffect` duals infer `R = unknown`, and inline validator calls
 * produce deferred conditional types that choke generic inference). Safe for
 * pure test effects that in practice require nothing. The result is `any` —
 * assertions against it are runtime-checked.
 */
// oxlint-disable-next-line no-explicit-any
export const runEffect = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>)

/**
 * Input for a provider's `read` lifecycle **as the planner calls it for a
 * resource with no persisted state** — the greenfield adoption probe.
 *
 * The desired props ride on `olds` (alchemy's naming on the `read` input) and
 * `output` is undefined. This is the only provider hook the planner invokes
 * for a brand-new resource, so it is where plan-time props validation fires.
 */
export const readInput = (props: unknown) => ({
  id: 'test-id',
  fqn: 'test',
  instanceId: 'inst',
  olds: props,
  output: undefined,
})

/**
 * Run a provider's `read` lifecycle with greenfield inputs and return the
 * result. Fails the test if the provider defines no `read`.
 */
export const runRead = async (
  // oxlint-disable-next-line no-explicit-any
  provider: { read?: (input: any) => Effect.Effect<any, any, any> },
  props: unknown,
): Promise<unknown> => {
  if (!provider.read) throw new Error('provider has no read lifecycle')
  return runEffect(provider.read(readInput(props)))
}

/**
 * The standard `diff` lifecycle input. Every provider's `diff` reads only
 * `news` / `olds` (plus this fixed bookkeeping) — the other fields are
 * engine bookkeeping that no Nebius diff inspects.
 */
export const diffInput = (news: unknown, olds?: unknown) => ({
  id: 'test-id',
  fqn: 'test',
  instanceId: 'inst',
  olds,
  news,
  oldBindings: [],
  newBindings: [],
  output: undefined,
})

/**
 * Run a provider's `diff` lifecycle with resolved `news`/`olds` and return the
 * result: `{ action: 'replace' }`, `{ action: 'update' }`, or `undefined`
 * (noop). Fails the test if the provider defines no `diff`.
 */
// oxlint-disable-next-line no-explicit-any — approved: test helper
// Bridging Effect.fn's `any`-captured context requirements — the input is
// only forwarded to the provider's diff lifecycle.
export const runDiff = async (
  // oxlint-disable-next-line no-explicit-any
  provider: { diff?: (input: any) => Effect.Effect<any, any, any> },
  news: unknown,
  olds?: unknown,
): Promise<unknown> => {
  if (!provider.diff) throw new Error('provider has no diff lifecycle')
  return runEffect(provider.diff(diffInput(news, olds)))
}

/**
 * Engine bookkeeping every lifecycle input carries and no Nebius lifecycle
 * inspects. Kept in one place so lifecycle tests need no per-test casts (the
 * provider lifecycle inputs are strictly typed — props, branded attribute ids,
 * `ScopedPlanStatusSession` — which is exactly what tests should not reproduce).
 */
const bookkeeping = () => ({
  id: 'test-id',
  fqn: 'test',
  instanceId: 'inst',
  bindings: [],
  session: fakeSession,
})

/**
 * Run a provider's `reconcile` lifecycle (create/update) and return the
 * attributes. `output` is the persisted state: `undefined` for a create.
 * Fails the test if the provider defines no `reconcile`.
 *
 * `...layers` are applied in order — `stackLayer`, `testConfigLayer`,
 * `instanceIdLayer` and a `mockComputeLayer`/`mockIamLayer` are typically needed.
 */
// oxlint-disable-next-line no-explicit-any — approved: test helper (see runDiff)
export const runReconcile = async (
  // oxlint-disable-next-line no-explicit-any
  provider: { reconcile?: (input: any) => Effect.Effect<any, any, any> },
  props: unknown,
  output?: { id: string },
  olds?: unknown,
  // oxlint-disable-next-line no-explicit-any
  ...layers: Array<(effect: Effect.Effect<any, any, any>) => Effect.Effect<any, any, any>>
  // oxlint-disable-next-line no-explicit-any — attributes are asserted at runtime
): Promise<any> => {
  if (!provider.reconcile) throw new Error('provider has no reconcile lifecycle')
  // oxlint-disable-next-line no-explicit-any
  let effect: Effect.Effect<any, any, any> = provider.reconcile({ ...bookkeeping(), news: props, olds, output })
  for (const provide of layers) effect = provide(effect)
  return runEffect(effect)
}

/**
 * Run a provider's `delete` lifecycle, expecting success. Fails the test if the
 * provider defines no `delete`.
 */
// oxlint-disable-next-line no-explicit-any — approved: test helper (see runDiff)
export const runDelete = async (
  // oxlint-disable-next-line no-explicit-any
  provider: { delete?: (input: any) => Effect.Effect<any, any, any> },
  output: { id: string },
  olds?: unknown,
  // oxlint-disable-next-line no-explicit-any
  ...layers: Array<(effect: Effect.Effect<any, any, any>) => Effect.Effect<any, any, any>>
): Promise<unknown> => {
  if (!provider.delete) throw new Error('provider has no delete lifecycle')
  // oxlint-disable-next-line no-explicit-any
  let effect: Effect.Effect<any, any, any> = provider.delete({ ...bookkeeping(), olds, output })
  for (const provide of layers) effect = provide(effect)
  return runEffect(effect)
}

/**
 * Run a provider's `delete` lifecycle expecting a **typed failure**, and return
 * that failure (the `Effect.flip` a refusal test wants). Fails the test if the
 * provider defines no `delete`.
 */
// oxlint-disable-next-line no-explicit-any — approved: test helper (see runDiff)
export const runDeleteExpectingError = async (
  // oxlint-disable-next-line no-explicit-any
  provider: { delete?: (input: any) => Effect.Effect<any, any, any> },
  output: { id: string },
  olds?: unknown,
  // oxlint-disable-next-line no-explicit-any
  ...layers: Array<(effect: Effect.Effect<any, any, any>) => Effect.Effect<any, any, any>>
): Promise<any> => {
  if (!provider.delete) throw new Error('provider has no delete lifecycle')
  // oxlint-disable-next-line no-explicit-any
  let effect: Effect.Effect<any, any, any> = provider.delete({ ...bookkeeping(), olds, output })
  for (const provide of layers) effect = provide(effect)
  return runEffect(Effect.flip(effect))
}
