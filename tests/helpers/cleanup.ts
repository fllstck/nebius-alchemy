/**
 * Shared cleanup helpers for integration tests.
 *
 * The ubiquitous cleanup pattern (`Effect.ensuring(stack.destroy()...)`) dumped
 * raw error strings to test output. With real credentials in play, error
 * strings must be treated as potentially sensitive — `redact()` masks any key
 * material before it reaches the logs, and `safeDestroy()` bundles the
 * redacted logging with exit-aware cleanup semantics (see below).
 */
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import type { ScratchStack } from 'alchemy/Test/Bun'

// ---------------------------------------------------------------------------
// redact()
// ---------------------------------------------------------------------------

/**
 * Credential field names whose values must never be logged. Matches common
 * variants: accessKeyId, access_key, apiKey, secretKey, secretAccessKey,
 * token, secret, password — case-insensitively.
 */
const SENSITIVE_KEY =
  '(?:access[_-]?key(?:_?id)?|secret[_-]?access[_-]?key|secret[_-]?key|api[_-]?key|token|secret|password)'

/** `key=value` / `key: value` — unquoted or single-quoted values. */
const KEY_VALUE_RE = new RegExp(
  `(${SENSITIVE_KEY})(\\s*[:=]\\s*)(["']?)[^"'\\s,}]+\\3`,
  'gi',
)

/** JSON style: `"key": "value"` (double- or single-quoted). */
const JSON_KEY_VALUE_RE = new RegExp(
  `["'](${SENSITIVE_KEY})["']\\s*[:=]\\s*["'][^"']*["']`,
  'gi',
)

/** `Bearer <token>` — covers Authorization headers and standalone tokens. */
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+=*/gi

/**
 * Mask sensitive key material in a string before logging.
 *
 * Covers `key=value` / `key: value` forms (including inside gRPC `details`
 * payloads and JSON dumps) and bearer tokens. Non-sensitive strings pass
 * through unchanged.
 */
export const redact = (input: string): string => {
  if (input === '') return input
  // Bearer first so the token is consumed even when prefixed by a key
  // (e.g. `Authorization: Bearer eyJ...`).
  return input
    .replace(BEARER_TOKEN_RE, 'Bearer <redacted>')
    .replace(KEY_VALUE_RE, (_match, key: string, sep: string) => `${key}${sep}<redacted>`)
    .replace(JSON_KEY_VALUE_RE, (_match, key: string) => `"${key}": "<redacted>"`)
}

// ---------------------------------------------------------------------------
// DestroyFailedError
// ---------------------------------------------------------------------------

/**
 * A stack destroy failed after the test body itself succeeded.
 *
 * Raised by {@link safeDestroy} so a leaked resource fails the test instead
 * of being silently logged away. When the body ALSO failed, the destroy
 * error is logged (redacted) only — the body's own failure must never be
 * masked by a cleanup error.
 */
export class DestroyFailedError extends Schema.TaggedErrorClass<DestroyFailedError>()('DestroyFailedError', {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// safeDestroy()
// ---------------------------------------------------------------------------

/**
 * Run a test body with guaranteed, exit-aware stack cleanup.
 *
 * Semantics (documented so they aren't weakened later):
 *
 * - Body **succeeded** → destroy runs; a destroy failure FAILS the test with
 *   {@link DestroyFailedError} (the resource leaked — silence would hide it).
 * - Body **failed** → destroy still runs, but its failure is logged (redacted)
 *   and ignored so the body's own error is what surfaces.
 * - Body **interrupted** → destroy still runs; the interruption is re-raised.
 *
 * All destroy error strings are {@link redact}ed before logging.
 *
 * Usage — replaces the previous `Effect.ensuring(safeDestroy(stack))` shape
 * (which could not propagate destroy failures without masking body failures,
 * since `ensuring` finalizers are typed `E = never`):
 *
 *   Effect.gen(function* () { ... }).pipe(
 *     safeDestroy(stack),
 *   )
 */
export const safeDestroy = (
  stack: ScratchStack,
  // oxlint-disable-next-line no-explicit-any — verify effect's R varies by test
  verify?: Effect.Effect<unknown, unknown, any>,
) =>
  <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E | DestroyFailedError, R> =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(body)

      if (Exit.isFailure(exit)) {
        // Body failed (or was interrupted): cleanup must run, but must not
        // mask the body's own outcome. Log-redact destroy errors and ignore.
        yield* stack.destroy().pipe(
          Effect.tapError((e) =>
            Effect.logError(
              `[cleanup] destroy failed (body already failed): ${redact(String(e))}`,
            ),
          ),
          Effect.ignore,
        )
        if (verify) {
          // Still check for leaks — log loudly (the body's failure wins).
          yield* Effect.exit(verify).pipe(
            Effect.tap((v) =>
              Exit.isFailure(v)
                ? Effect.logError(
                    `[cleanup] LEAK VERIFICATION FAILED (body already failed): ${redact(String(v.cause))}`,
                  )
                : Effect.void,
            ),
          )
        }
        // Re-raise the original failure (or interruption) unchanged.
        return yield* Effect.failCause(exit.cause)
      }

      // Body succeeded: a failed cleanup means a leaked resource — fail the test.
      yield* stack.destroy().pipe(
        Effect.tapError((e) =>
          Effect.logError(`[cleanup] destroy failed: ${redact(String(e))}`),
        ),
        Effect.mapError(
          (e) => new DestroyFailedError({ message: redact(String(e)) }),
        ),
      )
      if (verify) {
        // Any leftover resource after a successful destroy is a leak — fail.
        yield* verify.pipe(
          Effect.tapError((e) =>
            Effect.logError(`[cleanup] LEAK VERIFICATION FAILED: ${redact(String(e))}`),
          ),
          Effect.mapError(
            (e) => new DestroyFailedError({ message: redact(String(e)) }),
          ),
        )
      }
      return exit.value
    })
