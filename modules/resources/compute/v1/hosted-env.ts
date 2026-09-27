/**
 * The rules an **env key** must satisfy in the shipped `EnvironmentFile=` — shared by the deploy-side
 * writer (`hosted.ts`) and the plan-time guards (`instance.ts`).
 *
 * ## Why this module exists at all
 *
 * The predicate belongs to neither owner. `instance.ts` is the runtime half of the hosted instance and is
 * bundled into every program, so its D8 guard forbids a static import of `hosted.ts` (rolldown/vite, the
 * gRPC api-clients and the proto schemas would land in the bundle — measured 1917.9 KB → 160.6 KB). And
 * `hosted.ts` cannot reach into `instance.ts`. So the shared, dependency-free part lives here: string
 * work and one `Schema.TaggedError`, nothing else.
 *
 * ## The measurement behind it
 *
 * systemd's `EnvironmentFile=` parser (v255 — the version the `ubuntu24.04-driverless` target image ships)
 * reads a **key** up to the first `=` and ends an assignment at a newline. `quoteEnvValue` quotes and
 * escapes everything on the *value* side, and — since R-19 — deliberately leaves a newline there verbatim
 * because a quoted newline is how a multi-line value is transported (the parser's quoted states append
 * every character but the quote, and `load_env_file` uses that same parser). A *key* has no such quoting,
 * so the same characters are silently destructive:
 *
 * ```ts
 * renderEnvFile({ 'KE\nY': 'v' })  // two lines → TWO assignments: KE and Y
 * renderEnvFile({ 'A=B': 'v' })    // "A=B='v'"  → key A with the value "B='v'"
 * ```
 *
 * Both are read as a different variable than the one configured, with nothing in the deploy output saying
 * so — the class of silent, unmeasured misbehaviour this repo's R-06 family is about. The guard is
 * therefore *three impossible characters*, not an env-name charset: `MY.KEY`, `MY-KEY` and `MY_KEY` are all
 * fine and must stay fine, or the check becomes an unrelated breaking change.
 *
 * WHERE IT FIRES — three places, because the key sources differ:
 *
 * 1. `diff` (plan-time, after `AlchemyDiff.isResolved` — an `env` *value* may legitimately be an `Output`)
 *    and 2. the top of `reconcile`: these see the **user's** `env` prop.
 * 3. `uploadHostedArtifacts` (compose-time backstop): the final map also carries **binding-supplied**
 *    keys, which exist only at that point and which no call path can bypass.
 */
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/**
 * The hosted env map contains a key that systemd's `EnvironmentFile=` parser cannot read back as written.
 *
 * `keys` holds the offending keys **verbatim** (a newline in a key is invisible in a log line otherwise,
 * so the message JSON-encodes each one).
 */
export class InvalidHostedEnvKey extends Schema.TaggedError<InvalidHostedEnvKey>()('InvalidHostedEnvKey', {
  /** The offending keys themselves, so a caller can act on them without re-parsing the message. */
  keys: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** The three characters systemd reads as structure inside a key: assignment end, line end, key/value split. */
const STRUCTURAL_IN_KEY = ['=', '\n', '\r'] as const

/**
 * The keys of `env` that cannot survive the round-trip through `EnvironmentFile=`. Pure, so both the
 * Effect guards and a plain test can use it.
 */
export const invalidHostedEnvKeys = (env: Record<string, unknown> | undefined): Array<string> =>
  Object.keys(env ?? {}).filter((key) => STRUCTURAL_IN_KEY.some((character) => key.includes(character)))

/**
 * Fail when any key in `env` is unrepresentable. `Effect.void` for the well-formed case, so call sites can
 * `yield*` it unconditionally — and a map with no keys at all (the common case) is a no-op.
 */
export const assertHostedEnvKeys = (
  env: Record<string, unknown> | undefined,
): Effect.Effect<void, InvalidHostedEnvKey> => {
  const keys = invalidHostedEnvKeys(env)
  if (keys.length === 0) return Effect.void
  return Effect.fail(
    new InvalidHostedEnvKey({
      keys,
      message:
        `The hosted env key(s) ${keys.map((key) => JSON.stringify(key)).join(', ')} cannot be represented in the ` +
        `systemd EnvironmentFile the VM reads: systemd ends a key at the first '=' and an assignment at a ` +
        `newline, so the process would receive a DIFFERENT variable than the one configured here (nothing ` +
        `in the deploy output would say so). Use a plain name — MY_KEY, MY-KEY and MY.KEY are all fine. ` +
        `The value side is unrestricted: quoting handles spaces, quotes and multi-line values.`,
    }),
  )
}
