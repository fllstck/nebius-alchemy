/**
 * Effect helpers shared by modules that talk to the outside world.
 */
import * as Effect from 'effect/Effect'

/**
 * `Effect.tryPromise` in its **object** form, failing with the raw rejection.
 *
 * The thunk form — `Effect.tryPromise(() => promise)` — routes every rejection
 * through Effect's `UnknownError`, whose `message` is the generic *"An error
 * occurred in Effect.tryPromise"* and which is **not** an instance of whatever
 * the call actually threw (`node_modules/effect/dist/internal/effect.js`: the
 * thunk-form catcher is `cause => new UnknownError(cause, …)`). The original
 * lives on only as `UnknownError.cause`, which nothing downstream looks at. That
 * silently breaks two things:
 *
 * - **Retry classification.** A predicate like `error instanceof ServerError`
 *   is never true, so a "retry transient failures" policy degrades into "retry
 *   everything" — permanent 4xx included.
 * - **Failure messages.** `e instanceof Error ? e.message : String(e)` reports
 *   the wrapper, so the operator never sees `invalid_client`, `AccessDenied`,
 *   `ENOENT`, or the HTTP status the call returned.
 *
 * Use this wherever a rejection is classified or rendered downstream; keep the
 * plain thunk form only where the error's identity genuinely carries no
 * information.
 */
export const tryPromiseRaw = <A>(thunk: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause })
