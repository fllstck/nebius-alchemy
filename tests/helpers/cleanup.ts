/**
 * Shared cleanup helpers for integration tests.
 *
 * The ubiquitous `Effect.ensuring(stack.destroy()...)` cleanup pattern dumped
 * raw error strings to test output. With real credentials in play, error
 * strings must be treated as potentially sensitive — `redact()` masks any key
 * material before it reaches the logs, and `safeDestroy()` bundles the
 * log-redacted, error-ignored destroy.
 */
import * as Effect from 'effect/Effect'
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
// safeDestroy()
// ---------------------------------------------------------------------------

/**
 * Destroy a scratch stack with guaranteed, redacted cleanup logging.
 *
 * On destroy failure, logs the error with {@link redact} applied and ignores
 * it — a destroy failure must never mask the test body's own outcome, but its
 * error string must not leak key material.
 *
 * Usage (inside `Effect.ensuring`, mirroring the previous inline pattern):
 *
 *   Effect.ensuring(safeDestroy(stack))
 */
export const safeDestroy = (stack: ScratchStack) =>
  stack.destroy().pipe(
    Effect.tapError((e) =>
      Effect.logError(`[cleanup] destroy failed: ${redact(String(e))}`),
    ),
    Effect.ignore,
  )
