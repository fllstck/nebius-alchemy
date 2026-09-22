/**
 * `modules/Credentials.ts` — the credential service every provider's gRPC transport reads its API key
 * from (`GrpcTransport` does `yield* yield* NebiusCredentials`).
 *
 * Three behaviours, each of which a caller depends on:
 *
 * 1. **The shape**: the service yields `{ apiKey: Redacted<string> }` — the key never travels as a
 *    plain string.
 * 2. **`Effect.cached`**: resolution runs ONCE per layer, no matter how many times the service is
 *    used. Every gRPC channel in the process resolves through this service, so re-running
 *    `resolveProviderConfig` per call would re-read the profile (and re-prompt, in the interactive
 *    flows) on every request. Dropping `.cached` is a plausible-looking edit, so it is pinned.
 * 3. **`Effect.orDie`**: a resolution failure arrives as a **defect**, not a typed `AuthError` — the
 *    service's type is `Effect<{apiKey}>` (no error channel), so a typed failure would have nowhere
 *    to go. Pinning the die (rather than a `catchAll`-able failure) is what makes the contract
 *    explicit.
 *
 * ⚠️ The seam is a **module-level function call** inside the layer body: `fromAuthProvider` calls
 * `resolveProviderConfig` directly at layer-construction time, so there is nothing to provide — the
 * only double is `mock.module`. That is scoped to this file's process (each bun test file gets its
 * own) and installs *before* the dynamic import of the module under test, so the real alchemy module
 * keeps every other export.
 */
import { beforeEach, describe, expect, test, mock } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Redacted from 'effect/Redacted'
import * as AlchemyAuth from 'alchemy/Auth'
import { AuthError } from 'alchemy/Auth/AuthProvider'

/** The fake the layer will see: records calls so "resolve once" is observable. */
const state = {
  calls: 0,
  /** What `resolve` answers next. */
  key: 'api-key-from-provider',
  fail: undefined as AuthError | undefined,
  failProfileSelection: undefined as AuthError | undefined,
}

// `mock.module` is typed `void | Promise<void>`; awaiting it also guarantees the mock is installed
// before the dynamic import below.
await mock.module('alchemy/Auth', () => ({
  ...AlchemyAuth,
  resolveProviderConfig: () =>
    Effect.suspend(() => {
      if (state.failProfileSelection !== undefined) return Effect.fail(state.failProfileSelection)
      return Effect.succeed({
        auth: undefined,
        profileName: 'test-profile',
        config: { method: 'stored' },
        source: 'profile' as const,
        resolve: Effect.suspend(() => {
          state.calls += 1
          if (state.fail !== undefined) return Effect.fail(state.fail)
          return Effect.succeed({
            type: 'apiKey' as const,
            apiKey: Redacted.make(state.key),
            source: { type: 'stored' as const },
          })
        }),
      })
    }),
}))

// Imported AFTER the mock is installed — the module reads `resolveProviderConfig` through the
// mocked specifier.
const { fromAuthProvider, NebiusCredentials } = await import('../modules/Credentials.ts')

beforeEach(() => {
  state.calls = 0
  state.key = 'api-key-from-provider'
  state.fail = undefined
  state.failProfileSelection = undefined
})

/** Read the service and dereference it twice — the shape every caller uses. */
const readTwice = Effect.gen(function* () {
  const credentials = yield* NebiusCredentials
  const first = yield* credentials
  const second = yield* credentials
  return { first, second }
})

/**
 * `fromAuthProvider`'s real type carries alchemy's requirements (`AuthProviders`, `ProfileStore`, …)
 * even though the mocked `resolveProviderConfig` needs none of them — the layer is typed by what the
 * production code requires, and TS cannot know the mock is in place. One cast, here, rather than a
 * cast at every call site.
 */
const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(fromAuthProvider)) as unknown as Effect.Effect<A, E, never>,
  )

describe('Credentials.NebiusCredentials', () => {
  test('yields the provider api key as a Redacted string', async () => {
    const { first, second } = await run(readTwice)

    expect(first.apiKey).toBeInstanceOf(Object)
    expect(Redacted.value(first.apiKey)).toBe('api-key-from-provider')
    expect(Redacted.value(second.apiKey)).toBe('api-key-from-provider')
    // The document itself is not a plain string (so a log or a defect cannot print the key).
    expect(typeof first.apiKey).not.toBe('string')
  })

  test('resolves ONCE per layer, however many times the service is used', async () => {
    await run(readTwice)
    expect(state.calls).toBe(1)
  })

  test('two separate layers each resolve once (the cache is per layer, not global)', async () => {
    await run(readTwice)
    await run(readTwice)
    expect(state.calls).toBe(2)
  })

  test('a resolution failure is a DEFECT, so it cannot be swallowed as a typed error', async () => {
    state.fail = new AuthError({ message: 'profile credentials missing' })

    const exit = await run(
      Effect.gen(function* () {
        const credentials = yield* NebiusCredentials
        // A caller that tries to *handle* the failure must still die: `orDie` is what makes the
        // service's `E = never` honest rather than a lie the compiler believes.
        return yield* credentials.pipe(Effect.catch(() => Effect.succeed('swallowed')))
      }).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain('profile credentials missing')
      // A defect (die), not a typed failure that `catchTag`/`catchAll` could have taken.
      expect(JSON.stringify(exit.cause)).toContain('Die')
    }
  })

  test('a failure while SELECTING the profile (before any read) surfaces loudly', async () => {
    state.failProfileSelection = new AuthError({ message: 'no profile selected' })

    // A failing layer cannot produce a service at all, so this arrives as a layer-construction
    // error rather than an `Exit` — either way the caller never sees a credential-less service.
    const thrown = await run(
      Effect.gen(function* () {
        const credentials = yield* NebiusCredentials
        return yield* credentials
      }),
    ).then(
      () => undefined,
      (error: unknown) => String(error),
    )

    expect(thrown).toContain('no profile selected')
  })

  test('the failed resolution is not cached as a success', async () => {
    state.fail = new AuthError({ message: 'first attempt fails' })
    const failing = await run(
      Effect.gen(function* () {
        const credentials = yield* NebiusCredentials
        return yield* credentials
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(failing)).toBe(true)

    // A fresh layer with a healthy provider resolves normally — the cache never memoized the defect.
    state.fail = undefined
    state.calls = 0
    const { first } = await run(readTwice)
    expect(Redacted.value(first.apiKey)).toBe('api-key-from-provider')
    expect(state.calls).toBe(1)
  })
})
