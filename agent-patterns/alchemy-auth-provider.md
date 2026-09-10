# Alchemy AuthProvider Patterns

> Extracted from `node_modules/alchemy/src/Auth/AuthProvider.ts`,
> `Auth/Profile.ts`, `Auth/Resolve.ts`, `Auth/Credentials.ts`, and
> `Interaction.ts` at `alchemy@2.0.0-beta.77` / `effect@4.0.0-rc.112`.
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

## Testing

Do **not** wire auth providers with `Effect.provide` + `Layer.mergeAll(...)`.
Use `make()` from `alchemy/Test/Bun` (imported as `AlchemyTestUtilities` in this
repo's docs), and provide `Interaction` explicitly — `alchemy/Interaction`
offers a non-interactive layer for this. Scripted prompts beat mocking the
service.
