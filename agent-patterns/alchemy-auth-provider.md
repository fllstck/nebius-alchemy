# Alchemy AuthProvider Patterns

> Extracted from `node_modules/alchemy/src/Auth/AuthProvider.ts`,
> `Auth/Profile.ts`, `Auth/Resolve.ts`, `Auth/Credentials.ts`, and
> `Interaction.ts` at `alchemy@2.0.0-beta.79` / `effect@4.0.0-rc.117`.
> (Re-verified across `beta.77 → beta.79`: the only delta in these files is the
> upstream `Config.string` → `Config.String` rename, so the contract below is
> unchanged since beta.77.)
>
> **The interface was rewritten in beta.77** (this file replaces the old
> 7-generic-param shape). If you are reading older notes mentioning
> `ConfigureContext`, `prettyPrint`, `retryOnce`, or `Clank`, they are stale.

## The contract

```ts
export interface AuthProviderImpl<
  Config extends { method: string } = { method: string },
  Credentials = unknown,
  R = never,
> {
  readonly configSchema: Schema.Codec<Config>          // REQUIRED
  configure(profileName: string, currentConfig?: Config)
    : Effect<Config, AuthError, R | Interaction>
  configureWith?(profileName, { method, values })       // optional, flag-driven
    : Effect<Config, AuthError, R | Interaction>
  readonly configureMethods?: ReadonlyArray<ConfigureMethod>  // required IF configureWith
  login(profileName, config, updateConfig?)
    : Effect<Config | void, AuthError, R | Interaction>
  logout(profileName, config): Effect<void, AuthError, R | Interaction>
  details(profileName, config, updateConfig?)
    : Effect<ProviderDetails, AuthError | NeedsReauth, R>
  read(profileName, config, updateConfig?)
    : Effect<Credentials, AuthError | NeedsReauth, R>
  readonly readEnvironment?: Effect<Credentials, AuthError, R>
  readonly environment?: ReadonlyArray<EnvironmentVariable>   // required IF readEnvironment
}
```

Register with:

```ts
export const MyAuth = AuthProviderLayer<MyConfig, MyCredentials>()(
  'MyProvider',
  Effect.gen(function* () {
    const credentialStore = yield* CredentialsStore
    // ...
    return { configSchema, configure, login, logout, details, read, ... }
  }),
)
```

Note the layer's generic arity: `<Config, Credentials>()` then `<R, ImplReq>`.
The old 6-request-generic form is gone.

## Rule 1 — `Interaction` must be resolved LAZILY, per method

**Never** capture `Interaction` at layer construction:

```ts
// ❌ WRONG — makes the declared Interaction requirement a dead letter
Effect.gen(function* () {
  const interaction = yield* Interaction
  return { configure: () => interaction.prompt.select(...) }
})
```

The `AuthProvider` wrapper intentionally omits `Interaction` when it snapshots
the registration context, so an ambient registration-time `Interaction` would
silently shadow whatever the *caller* provides (a scripted test, a
browser-driven login). Resolve it inside each method that needs it:

```ts
// ✅ RIGHT
const configure = Effect.fn('MyAuth.configure')(function* (profileName) {
  const interaction = yield* Interaction
  const method = yield* interaction.prompt.select({ ... }).pipe(mapPromptCancellation)
})
```

### Rule 1b — `read` / `details` / `readEnvironment` must stay non-interactive

These three are exercised by **child processes**, whose graphs carry no
interaction services. They must not yield `Interaction` and must not prompt —
fail with `NeedsReauth` instead and let the caller re-authenticate.

## Rule 2 — the error channel is `AuthError` / `NeedsReauth` only

Interactive methods admit **only** `AuthError`. Anything else leaks a type
error at the `AuthProviderLayer` call site. The common offender is a helper
whose error channel is wider than you expect — e.g. `writeSecureCredentials`
also fails with `PlatformError` from its post-write `chmod 0600`:

```ts
// Normalise at the boundary
const toAuthError = (cause: unknown): AuthError =>
  cause instanceof AuthError
    ? cause
    : new AuthError({ message: 'credentials could not be saved', cause })

const configure = (profileName, currentConfig?) =>
  configureInteractive(profileName, currentConfig).pipe(Effect.mapError(toAuthError))
```

Use `NeedsReauth` (not `AuthError`) when stored credentials **exist but can't be
used** — an expired token, a rotated secret. The profile UI renders that as
"needs re-login" and callers match it with `Effect.catchTag("NeedsReauth", …)`.
Never signal it by inspecting a message.

## Rule 3 — model config with a Schema and derive the type

`configSchema` decodes stored, user-editable JSON and may have been written by a
different alchemy version, so every load is validated. Derive the type from the
schema so the two cannot drift:

```ts
export const MyAuthConfigSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal('env') }),
  Schema.Struct({ method: Schema.Literal('oauth') }),
])
export type MyAuthConfig = typeof MyAuthConfigSchema.Type
```

Same for credential documents:

```ts
export const MyStoredSchema = Schema.Struct({
  type: Schema.Literal('apiKey'),
  apiKey: Schema.String,
})
export type MyStored = typeof MyStoredSchema.Type
```

## Rule 4 — `CredentialsStore` round-trips through a Schema

`read`/`write` take a codec. There is no schema-free overload:

```ts
// ❌ old
yield* store.read<MyCreds>(profileName, KEY)
// ✅ now
yield* store.read(profileName, KEY, MyCredsSchema)
yield* store.write(profileName, KEY, MyCredsSchema, value)
```

Thread the schema through any project-local wrapper (e.g.
`writeSecureCredentials`), and widen its error channel accordingly.

## Rule 5 — CI is `readEnvironment` + `environment`, not a `ci` flag

The old `configure(name, ctx: ConfigureContext)` carried `ctx.ci`. That is
gone. Declare your environment contract and implement the reader; alchemy
decides precedence:

```ts
const environment: ReadonlyArray<EnvironmentVariable> = [
  { name: 'MY_API_TOKEN', required: true, secret: true },
  { name: 'MY_ACCOUNT_ID', required: false },
]

const readEnvironment = Effect.gen(function* () {
  const token = yield* getEnvRedacted('MY_API_TOKEN')
  if (!token) return yield* new AuthError({ message: 'Set MY_API_TOKEN.' })
  return { type: 'apiKey' as const, apiKey: token, source: { type: 'env' as const } }
})
```

Implementing `readEnvironment` **without** declaring `environment` is a
programmer error — the wrapper `Effect.die`s at layer build to make CI
requirements discoverable. Same for `configureWith` without `configureMethods`.

### Rule 5b — `environment` is a PROBE, not documentation

This list is not "the variables my provider looks at". It is alchemy's
env-vs-profile precedence probe, consulted by `presentEnvironment`
(`Auth/AuthProvider.ts`) from `Auth/Demand.ts` and `Auth/Resolve.ts`:

```ts
// env-vs-profile decision, roughly:
const used = yield* presentEnvironment(auth.environment)
const envUsable = used !== undefined   // ← ANY entry present ⇒ env wins
```

So **an entry is only safe if its presence by itself implies usable
credentials.** Two ways to get this wrong, both of which cost a release cycle
here by breaking provider *loading* (so `alchemy profile edit --add Nebius`
could not run at all — the error was the useless "Could not load auth
providers"):

| Mistake | Failure |
| A variable the stack reads but that is not a credential (e.g. a project id) | Env branch selected with no credentials present ⇒ the resolution path runs `readEnvironment` ⇒ `AuthError` ⇒ `Layer.orDie` ⇒ the CLI cannot even collect the provider |
| A **group** of variables that are only sufficient together (an API key *or* id+key-id+private-key) | Any single one present counts as configured, so a half-set group hijacks resolution the same way. `required: false` is per-variable and cannot express "all of these OR that one" |

Both were invisible in CI (where the credential variables genuinely are set)
and only appeared once real profile-based credentials were exercised.

**Rules that follow:**

- List only variables whose presence alone means "credentials are usable".
  Groups and non-credential settings do not belong here; document them in the
  error message instead.
- `required: true` does not rescue a group. It means "resolution fails without
  this", and because `presentEnvironment` bails on the first missing required
  entry, it breaks the *other* alternatives rather than expressing the OR.
- Because the list gates the probe, a group-conditional credential path is
  **CI-only in practice**: under `CI=true`, alchemy skips the probe and calls
  `readEnvironment` directly, so the full group still works there.
- You cannot soften this from inside `readEnvironment`: the contract types it
  `Effect<Credentials, AuthError, R>` (see Rule 2), so it cannot emit the
  suppressible `MissingProviderConfig` that callers degrade on. The only lever
  is the list.
- Make the failure name the missing pieces — a half-set group is the most
  confusing way to arrive there, and the probe deliberately cannot detect it, so
  the message is the only place it surfaces.

Regression tests belong at `presentEnvironment(environment)` level (cheap, no
network): assert that a non-credential variable, a partial group, and a complete
group all yield `undefined`, and that only the genuinely self-sufficient
variables are listed.

## Rule 6 — `ProfileStore` replaced the old profile service

| Old | New |
| --- | --- |
| `AlchemyProfile` service | `ProfileStore` (`Context.Service`) |
| `ProfileLive` | `ProfileStoreLive` |
| `profile.loadOrConfigure(auth, name, { ci })` | `ProfileStore.loadProviderConfig(auth, name)` |
| `loadOrConfigure` + `auth.read(...)` | **`resolveProviderConfig(providerName)`** |

`resolveProviderConfig` is almost always what you want at a dependency site: it
prefers environment credentials, falls back to the selected profile, and hands
back `{ auth, profileName, config, resolve, source }` with `resolve` already
wired to `updateConfig` for persistence.

```ts
export const fromAuthProvider = Layer.effect(
  MyCredentials,
  Effect.gen(function* () {
    const { resolve } = yield* resolveProviderConfig<MyConfig, MyCreds>('MyProvider')
    return yield* resolve.pipe(Effect.map((c) => ({ apiKey: c.apiKey })), Effect.orDie, Effect.cached)
  }),
)
```

## Rule 7 — `Clank` is gone; use `Interaction`

`alchemy/Util/Clank` was **deleted**. Everything moved onto the `Interaction`
service:

| Old (`Clank`) | New |
| --- | --- |
| `Clank.info/success/warn/error(msg)` | `interaction.output.info/success/warning/error(msg)` |
| `Clank.text({ message, initialValue })` | `interaction.prompt.text({ message, initialValue })` |
| `Clank.password({ message })` | `interaction.prompt.password({ message })` |
| `Clank.select({ message, options })` | `interaction.prompt.select({ message, options })` |
| `Clank.confirm(...)` | `interaction.prompt.confirm(...)` |
| `Clank.openUrl(url)` | `openUrl(url)` from `alchemy/Interaction` |
| `retryOnce` (from `alchemy/Auth/Env`) | `mapPromptCancellation` |

**`Choice` renamed `hint:` → `description:`.** Old option objects will silently
type-error.

`mapPromptCancellation` is not a retry — it maps `InteractionError` onto
`AuthError`, which is what the contract requires. Wrap every prompt with it.

For a browser OAuth flow, prefer alchemy's shared helper over hand-rolling the
race — it handles open-failure, the waiting screen, and manual code paste:

```ts
import { browserOAuth } from 'alchemy/Auth/BrowserOAuth'
yield* browserOAuth({
  provider: 'MyProvider',
  url,
  callback: waitForCode,
  exchange: (input) => exchangeCallbackInput(input, authorization),
})
```

## Rule 8 — `prettyPrint` became `details`

The old contract captured `Console.log` output. Return structured data instead:

```ts
const details = (profileName, config) =>
  resolveCredentials(profileName, config).pipe(
    Effect.map((creds) => ({
      lines: [
        { key: 'apiKey', value: displayRedacted(creds.apiKey, 7) },
        { key: 'source', value: creds.source.type },
      ],
    })),
  )
```

Values must arrive **already redacted** — the display layer renders them
verbatim. `details` must not require `Interaction`.

## CLI vocabulary (beta.77)

**`alchemy login` no longer exists.** It was replaced by `alchemy profile`, and
calling the old name prints a pointer rather than working. A command rename
produces **no type error and no test failure** — only users hitting it — so it
has to be checked deliberately.

| Command | Purpose |
| --- | --- |
| `alchemy profile edit --add <Provider>` | Interactive setup (was `login`) |
| `alchemy profile edit --profile <p> --reconfigure <Provider>` | Re-do a provider's config |
| `alchemy profile refresh --profile <p> --provider <Provider>` | Renew credentials without reconfiguring |
| `alchemy profile show` / `list` / `current` | Status, all profiles, effective selection |
| `alchemy profile create` / `rename` / `delete` | Profile lifecycle |

**Never hand-roll these strings in provider error messages.** Alchemy exports
hint builders so every provider speaks one vocabulary:

```ts
import { reconfigureHint, refreshHint } from 'alchemy/Auth/AuthProvider'

// stale/absent config — needs (re)configuration
reconfigureHint('Nebius', profileName)
// → "Run `alchemy profile edit --profile <p> --reconfigure Nebius` to reconfigure."

// expired or rotated credentials — needs renewal only
refreshHint('Nebius', profileName)
// → "Run `alchemy profile refresh --profile <p> --provider Nebius`."
```

Pick by *intent*, not by whichever feels closest: an expired token is a
**refresh**, a missing/mismatched config is a **reconfigure**. Getting this
backwards sends users to a heavier flow than they need.

> ⚠️ **Unless the provider's credentials are not refreshable at all.** Nebius
> user-account OAuth is exactly that case: the stored credential has **no refresh
> token**, so `refreshHint` names a command that can never succeed (it also needs
> an entrypoint exporting the provider, which the profile CLI cannot find in a
> repo without `alchemy.run.ts` — verified live 2026-09-21: *"Provider 'Nebius'
> is not connected or registered"*). There, an expired token is a **reconfigure**:
> the 12 h token is re-issued by re-running `profile edit`. This provider used
> `refreshHint` at that branch and sent users into a dead end; it now uses
> `reconfigureHint`, pinned by `tests/AuthProvider.test.ts`
> (`not.toContain('alchemy profile refresh')`).

`AuthProviderImpl.configureWith` + `configureMethods` are the machine-readable
half of this — they are what let `alchemy profile edit --method … --set …`
validate and document a provider's flags without prompting.

Other CLI moves from the same overhaul (unused in this repo, listed so the next
audit does not re-derive them): `tail` → merged into `logs`; `aws` /
`cloudflare` → under `provider`; `sync` → gone; `drift` → new; `nuke` → under
`unsafe`.

## Testing

Do **not** wire auth providers with `Effect.provide` + `Layer.mergeAll(...)`.
Use `make()` from `alchemy/Test/Bun` (imported as `AlchemyTestUtilities` in this
repo's docs), and provide `Interaction` explicitly — `alchemy/Interaction`
offers a non-interactive layer for this. Scripted prompts beat mocking the
service.

### Test the FIRST-RUN path with an isolated `HOME`

`~/.alchemy` is derived from `HOME`, so pointing `HOME` at an empty directory is
the only cheap way to exercise a machine with **no** profiles — with a real
`HOME`, an existing profile masks the whole path:

```bash
HOME=/tmp/freshhome bun alchemy profile edit --add Nebius -c <entrypoint> --no-input
```

`--no-input` fails at the method-selection prompt, and **reaching that prompt is
the assertion**: it proves the provider was discovered without demanding
credentials. (This is how the 0.7.0 bootstrap bug was caught and later fixed.)

To simulate a machine that has a profile but **no credentials yet**, create an
empty profile and select it — an unknown `--profile` name fails earlier with
`Profile … does not exist`, which tests something else:

```bash
bun alchemy profile create fresh-probe
HOME=/tmp/freshhome bun alchemy profile edit --add Nebius --profile fresh-probe --no-input
```
