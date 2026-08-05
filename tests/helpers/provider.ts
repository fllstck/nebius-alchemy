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
