# Alchemy Binding-Implementation Patterns

> Hard-won from building Nebius S3 bindings for Cloudflare Workers. Read this
> before implementing ANY `Binding.Service` + Layer pair (storage, KMS,
> mysterybox, DNS…) — each item below cost real debugging time.

## Never resolve resource outputs inline in a binding impl

A binding impl declares resources lazily (`yield* Iam.ServiceAccount(...)`)
and needs their ids/values. **Do NOT resolve them via `yield* yield* sa.id`**
— the ambient `RuntimeContext` during a resource lifecycle is not the resolve
context, so this returns `undefined` (or hangs):

```ts
// ❌ Bad — undefined at deploy time
return new HostIdentity({
  serviceAccountId: yield* yield* sa.id,
})

// ✅ Good — pass the OUTPUT EXPRESSIONS through; alchemy resolves them where
// they're consumed (Input props + binding data run through `Output.evaluate`)
return { serviceAccountId: sa.id, groupId: group.id, awsAccessKeyId: key.awsAccessKeyId }
```

The alchemy-blessed precedent (R2 `BucketHttp`): `yield* bucket.bucketName`
yields an `Effect<string>` ACCESSOR that the runtime client resolves later —
never inline. Consequences:
- `HostIdentity`-style bundles hold `Output.Output<…>` (branded) fields, not strings.
- Grant calls pass the Outputs into resource props (Input resolves refs).
- Env values pushed to the Worker may be Outputs — the apply machinery
  (`Output.evaluate` on binding data) resolves them before upload.
- The R cast (erasing layer requirements) is legitimate at the stack boundary,
  but keep it encapsulated.

## Create in `reconcile`, not `precreate`, when the resource references a sibling

`precreate` receives **raw props** (refs unresolved — `waitForDeps` +
`Output.evaluate` only happen before `reconcile`). A resource whose create
needs another resource's id (an access key needs its SA) can NEVER be created
in the same deploy as that resource if it uses `precreate`. Move the create
into `reconcile` (when `output` is undefined) — refs resolve, one-time-secret
capture is unchanged. (Applied to `iam.v2.AccessKey`; unblocked the
hostIdentity one-deploy chain.)

## Effect-native Workers: entry structure for dev vs remote

- **Dev** (`alchemy dev`): the local provider accepts an impl with NO `main`.
- **Remote** (`alchemy deploy`): the provider REQUIRES `main`/`script`/`assets`.

Use a **separate entry file** with `main` pointing at it:

```ts
// examples/storage.bindings-worker.ts — the entry: impl + contracts + layers
export default Cloudflare.Worker('Api', { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket('assets', …)
    const getObject = yield* Nebius.storage.GetObject(bucket)
    return { fetch: … }
  }).pipe(Effect.provide(Layer.mergeAll(GetObjectHttp, PutObjectHttp))))

// examples/storage.bindings.ts — the stack
import Api from './storage.bindings-worker.ts'
export default Alchemy.Stack('Bindings', { providers: …, state: … },
  Effect.gen(function* () { const worker = yield* Api; return { workerUrl: worker.url } }))
```

NEVER point `main` at the stack file (`import.meta.url` of the stack): the
bundle drags in the provider/runtime machinery (including the `workerd` npm
lib whose `require.resolve` shim throws under workerd:
`Uncaught TypeError: e.resolve is not a function`).

## Shared env bindings must be registered once per host

Every capability of one host injects the SAME identity env (NEBIUS_* names).
Cloudflare rejects duplicate binding names in a single upload
(`Binding name 'X' already in use`). Dedupe by host + name:

```ts
const registeredEnvNames = new Set<string>()
const registerEnvOnce = … // filter already-registered names, skip empty, then host.bind
```

Module-level state is effectively per-deploy (`alchemy deploy` runs one deploy
per process; `alchemy dev` restarts the exec child per reload).

## Worker env bindings: `text` must be a plain STRING at upload (O7)

The worker provider maps `host.bind` data items **passthrough** to
Cloudflare's wire — it does NOT unwrap `Redacted` or re-classify values in
binding data (only the worker's `env` **prop** path does). An `Output` that
resolves to a `Redacted` OBJECT reaches the wire as `text` and fails startup:

```
ScriptStartupError: json: cannot unmarshal object into Go struct field PlainTextBinding.text of type string
```

Because classification runs BEFORE `Output.evaluate` (at `bindWorkerEnv`
time), you cannot infer the final shape from the raw value. Rules:

- **Env `text` values must resolve to a plain string** at apply time.
- **Force `secret_text` explicitly** via the `secret()` marker in
  `shared/bind-host.ts` — it's consumed at classification time (never
  survives into binding data) and the wrapped value resolves to the string:

  ```ts
  NEBIUS_ENDPOINT_AUTH_TOKEN: BindHost.secret(
    Output.map((t: string | undefined) => t ?? '')(endpoint.authToken),
  )
  ```
- **Direct `Redacted` values are unwrapped at classification** (`Redacted.value`)
  — the provider won't do it for you.
- Never `Output.map((v) => Redacted.make(...))` into a binding — the resolved
  object breaks the wire.

## Env derivation must be LENIENT — the plan phase evaluates binding data (O1)

Binding-data Outputs are evaluated during alchemy's **PLAN phase** too
(`Plan.ts`), against the resource's PERSISTED output — which has empty
status attrs before the first successful run. A fail-fast inside the env
Output (e.g. `Output.mapEffect` returning `Effect.fail`) fires at plan time
and blocks the deploy BEFORE reconcile can act:

```
ERROR (#3): EndpointNotRunning: Endpoint llm has no public endpoint yet …
  at plan.diff.resource (Plan.ts:826)
```

Resolution (three layers, no fail-fast in the Output):
1. **Env derivation is lenient**: empty status → `''` via `Output.map`,
   never an error.
2. **Readiness lives in the provider**: reconcile awaits the ready state
   (below) so the attrs the env reads are populated by apply time.
3. **A runtime guard** on the empty value gives the tagged error at call time.

## Readiness wait for post-create (status) attributes

When a binding reads a STATUS attribute (`publicEndpoints`), the provider
must not return attrs until the resource is actually ready — the create
OPERATION completes before the endpoint VM reaches RUNNING, and a dependent
resource's env eval would otherwise bind `''`:

- Wait for RUNNING on **fresh creates AND observed transient states**
  (PROVISIONING/STARTING/IMAGE_PULLING — a previous deploy may have crashed
  mid-provisioning).
- Do NOT wait on deliberately-stopped resources (STOPPED) — fail fast via
  the binding's runtime guard instead of hanging the deploy for the deadline.
- Emit **progress notes on state transitions** (`session.note`) with elapsed
  time + the platform's `stateDetails.message` — multi-minute provisioning
  must not be silent.
- On ERROR (or timeout) fail with a tagged error carrying the stateDetails
  reason (quota failures etc. are in `status.stateDetails.serviceError`).

## `publicEndpoints` mixes raw `IP:port` and the managed https URL — pick https

Nebius endpoint status puts the raw VM `IP:port` (`89.169.121.158:8000`)
BEFORE the managed tunnel URL in `publicEndpoints`. Blindly taking `[0]`
binds a value that isn't URL-constructible:

```ts
new URL('/v1/chat/completions', '89.169.121.158:8000') // throws Invalid URL string
```

Always prefer an absolute `http(s)://` entry (the stable managed tunnel URL);
return null (→ the runtime guard) when only raw entries exist.

## D8: guard provider exports so worker bundles DCE the gRPC graph

A Worker entry statically imports the RESOURCE modules (to declare
resources), and an unguarded `AlchemyProvider.succeed(...)` at module scope
keeps the whole deploy graph (gRPC clients, protobuf schemas, factories)
alive in the bundle — measured ~1.15 MB entry with gRPC markers. The bucket
module had the fix; apply it to EVERY resource module:

```ts
export const NebiusXProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusX>, never, any
> = globalThis.__ALCHEMY_RUNTIME__
  ? (undefined as unknown as Layer.Layer<…>)
  : AlchemyProvider.succeed(NebiusX, { … })
```

The bundler folds the guard to `true` in worker bundles and DCEs the branch;
at deploy time it's undefined and the real provider registers. (Backfilled to
all 35 resource modules via `spikes/backfill-provider-guard.ts`.) Result: AI
worker entry 1152 KB → 115 KB, zero gRPC.

### The guard removes the PROVIDER, not the module — three ways it leaks

Measured 2026-09-10 (see TASKS.md §D8). The guard is necessary but not
sufficient; each of these survived a correctly-guarded provider:

1. **A module-scope helper that references a gRPC service.**
   `const waitUntilRunning = Effect.fn('…')(function* () { … yield* AiGrpc.AiGrpcService … })`
   is a top-level CALL, and calls are assumed impure — rolldown keeps it, and the
   retained closure drags the whole api-client + proto-schema graph in. Fix:
   annotate the declaration `/* @__PURE__ */` so it becomes droppable when unused
   (it is still called normally at plan/deploy, where nothing folds). Hit
   `ai/v1/endpoint.ts` (88 `grpc-js` sites), `compute/v1/instance.ts`, and
   `iam/v2/access-key.ts`. AI example entry: 884 KB → 139 KB.
2. **A module-scope REFERENCE to a deploy-side module.** `instance.ts` passed
   `transformProps: (id, props) => Hosted.transformInstanceProps(id, props)` to
   `Alchemy.Platform` at module scope, so `hosted.ts` (→ `alchemy/Bundle` →
   rolldown/vite/postcss, the IAM api-client, protobuf schemas, s3-lite-client)
   stayed in the bundle even though the function body is dead at runtime. Fix:
   load it lazily behind the guard —
   `globalThis.__ALCHEMY_RUNTIME__ ? Effect.succeed(props) : Effect.flatMap(Effect.promise(() => import('./hosted.ts')), (H) => H.transformInstanceProps(id, props))`
   plus `yield* (yield* loadHosted()).…` at the deploy-only call sites (which live
   inside the guarded provider and vanish with it). Minimal hosted-instance
   bundle: entry 1917.9 KB → 160.7 KB (53.1 KB minified), total 4867 KB → 966 KB,
   `grpc-js`/`AccessPermit`/proto-schemas/s3-lite all 0.
3. **A static import of a deploy-side module with side effects.** Even unused,
   an import of a module the bundler cannot prove pure stays. `sideEffects:
   false` in package.json does NOT rescue it when the module is reached through a
   retained reference (see 2) — remove the reference, then the import goes too.

Rule of thumb: after the guard, check the bundle again. Anything the provider
body referenced that still has a module-scope reference or impure top-level call
will keep the graph alive.

## Bundle analysis: lib not src, entry size matters, lazy chunks are inert

- Rolldown resolves `alchemy` to **`lib/*.js`**, NOT `src/*.ts` — patching
  node_modules src has NO effect on bundles. Don't go down that path.
- **Total bundle size is misleading**: alchemy's core pulls the deploy engine
  + platform layers as DYNAMIC-import chunks (`BunServices`/`NodeServices`/
  `NodeSocket`, CLI tooling) that never load in a deployed worker. The
  binding module's ENTRY (main script — what startup evaluates) is ~112 KB
  even though the total is ~1 MB.
- Measure entry size + check for gRPC markers (`@grpc`, `node:net` as static
  imports) — `spikes/ai-bindings-bundle.ts` does both. Since 2026-09-10 that
  harness mirrors alchemy's own `Cloudflare/Workers/Sources/Rolldown.ts`
  option-for-option and has a REAL fold control (raw rolldown with an explicit
  `define`; `Bundle.build` lets `ALCHEMY_DEFINE` win, so a caller-supplied
  `false` is silently ignored).
- Scanning **sourcemaps** produces false marker hits: with alchemy's
  `sourcemap: 'hidden'` the original source text of DROPPED modules is embedded
  in the output, so a clean bundle appears to contain `grpc-js`. Measure with
  `sourcemap: false`.
- Hosted-instance bundles are a different consumer: the VM's fetch script
  downloads EVERY file in the manifest (entry + lazy chunks), so total size
  matters there even though only the entry is evaluated. Minification is worth
  it: 2749 KB → 966 KB total, entry 160.7 → 53.1 KB.

## Effect/API gotchas hit along the way

- `Effect.provide` has only a **single-layer curried overload** — for multiple
  layers chain the provides or use `Layer.mergeAll(...)` once.
- Effect-native `fetch` is an `HttpEffect`: the request comes via
  `yield* HttpServerRequest`, NOT a function argument.
- `HttpServerRequest.text` is an **Effect property** (`yield* request.text`),
  not a method.
- `Effect.either` does not exist in this Effect version — use `Effect.exit` +
  `Exit.isFailure` (or `Effect.match`).
- `Schema.Literal('a','b','c')` keeps ONLY the first value — use
  `Schema.Union([Schema.Literal('a'), Schema.Literal('b'), …])` (multi-value
  literals always take the array form; `Schema.Union` also takes an array).
- The Effect-based encoder is `Schema.encodeEffect(schema)(value)`; plain
  `Schema.encode` crashes this build (`encodeSync` works for sync contexts).
- `Schema.fromJsonString(schema)` composes JSON.parse + Schema decode for
  JSON-string payloads (SSE events, error bodies) — there is no
  `Schema.parseJson`.
- `Schema.decodeUnknownEffect(schema)(input)` is the Effect decoder
  (`decodeUnknownSync` for sync); `Schema.decodeUnknown` (no suffix) does not
  exist.
- `HttpServerResponse.json` returns an Effect — in a Worker fetch shape use
  `HttpServerResponse.jsonUnsafe` to return a plain response.
- `Bun.serve().url` is oddly typed for template literals — use
  `server.url.toString()`.
- `Effect.clock` does not exist — use `Clock.currentTimeMillis`
  (`effect/Clock`).
- A binding impl's layer requirements (`Worker | WorkerEnvironment`) can't be
  expressed in a stack effect's Req — satisfy them at the Worker impl boundary
  (Effect-native form) or cast at the stack boundary.

## Node compatibility for the CLI

Alchemy's CLI is Node-native (`#!/usr/bin/env node`) and its source uses
explicit `.ts` extensions. If your package uses extensionless relative imports
(`./Provider`), the CLI can't load it under Node and you're forced onto the
Bun path (known workerd spawn quirks). Add explicit `.ts` extensions to every
relative import (tsconfig needs `allowImportingTsExtensions` + `noEmit`) to
restore the Node path.

## Related

- `alchemy-test-patterns.md` — scratch-stack deploy semantics, staged deploys,
  idempotent deletes (the test-side counterpart)
- `tests/resources/storage/v1/bindings.integration.test.ts` — mocked-host impl
  test (runs the real layers with a `Self`-provided mock host)
