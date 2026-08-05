# Bindings — typed Nebius clients for Cloudflare Workers

Implementation plan for adding Alchemy **Bindings** to `@fllstck/nebius-alchemy`:
typed runtime clients that users bind to **their own Cloudflare Worker** — no
Nebius Function host. AWS Lambda/ECS/EKS is a documented follow-up (§AWS later).

## Goal

A user with their own Worker can write:

```ts
export default Cloudflare.Worker("Api", { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket("assets")
    const getObject = yield* Nebius.storage.Bucket.GetObject(bucket)
    return { fetch: /* uses getObject */ }
  }).pipe(Effect.provide(Nebius.storage.Bucket.GetObjectBinding)),
)
```

One line derives: (1) deploy-time credential minting + least-privilege grant on
Nebius, (2) env injected into the Worker as `plain_text`/`secret_text` bindings,
(3) a typed runtime client (s3-lite-client, fetch-based).

## Non-goals

- No `Nebius.compute.Function` host / custom runtime (explicitly out of scope)
- **No AWS host support in v1** — the AWS differences are documented in
  ["Adding AWS hosts later"](#adding-aws-hosts-later) and the design keeps an
  explicit extension point so it slots in without rework
- No event sources or sinks (no Nebius-native pub/sub to subscribe to)
- No AI endpoint bindings (`ChatCompletions`) — endpoints are expensive/slow to
  deploy, impractical to test; revisit later
- No KMS / mysterybox / DNS bindings in the first pass (same pattern, later)
- No local-dev emulation layers (`*Local`) — dev runs against the real cloud
- Not proposing changes to `alchemy` itself (the env-binding helper is a
  candidate for upstreaming later)

## Context — verified mechanics (from `node_modules/alchemy@2.0.0-beta.67`)

- A binding = contract (`Binding.Service<Self, Tag, Shape>`) + impl Layer.
  Contract is callable at the call site; impl is provided via `Effect.provide`.
- **Cloudflare path (what v1 uses):** alchemy's own CF bindings
  (`R2/BucketBinding.ts`, `SecretsStore/ReadSecretBinding.ts`) `yield* Worker`
  (typed host) and `yield* WorkerEnvironment` (runtime env), then register
  native bindings at deploy time:
  ```ts
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    yield* host.bind`${bucket}`({ bindings: [{ type: "r2_bucket", ... }] })
  }
  // runtime: read env[bindingName] off WorkerEnvironment
  ```
  `host.bind(data)` (Resource.ts) only pushes `{ sid, data }` onto
  `stack.bindings[hostFqn]`; the **Worker provider does all the linking** —
  merges `data.bindings` (`WorkerBinding[]`) into script upload metadata.
  `WorkerBinding` includes the wire shape `plain_text` / `secret_text` / `json`,
  so env injection is `{ bindings: [{ type: "plain_text"|"secret_text", name,
  text }] }`; `secret_text` deploys as a Cloudflare secret.
- **`__ALCHEMY_RUNTIME__` guard**: deploy-time wiring runs in the CLI process
  (Node); at runtime (deployed Worker **and** `alchemy dev` local workerd) the
  guard skips it. **M0-verified mechanism:** alchemy's bundler *folds* the guard
  (`ALCHEMY_DEFINE` in `Bundle.ts` replaces `globalThis.__ALCHEMY_RUNTIME__`
  with `true` at build time) and dce-only minify physically removes the
  `if (false)` branch — including anything inside it, such as a dynamic
  `await import()`. The folded marker never appears in the bundle.
- **The AWS path differs (noted, not built now):** AWS Lambda/ECS/EKS merge
  `data.env` into function config and `data.policyStatements` into IAM
  (`Function.ts:938`); narrowed by `isBindingHost` (checks `Type` ∈
  Lambda.Function | ECS.Task | ECS.Service | EKS.Deployment | EKS.Job). No
  universal env shape exists across families — see §AWS later.
- **Precedent for credential minting:** Cloudflare `AccountApiToken` — a
  resource (a) declared **lazily from inside a binding impl**
  (`yield* Token(`${self.LogicalId}Token`)`), (b) persisting a **one-time
  plaintext secret in its output** so later deploys re-read it. Our
  `iam.v2.AccessKey` already does (b) via `precreate` + preserve-from-output.
- **Import surface (M0-verified):** `alchemy/Binding` subpath works (`./*` →
  `src/*.ts`). `Worker` / `WorkerEnvironment` / `isWorker` / `WorkerBinding`
  come from **`alchemy/Cloudflare/Workers`** (the namespace index) — NOT from
  `alchemy/Cloudflare/Workers/Worker`: the exports map routes `./Cloudflare/*`
  to `*/index.ts` only, so multi-segment CF subpaths do not resolve. All
  workerd-safe (CF's own modules, fetch-based). (For later: `./AWS/Lambda/*`
  has a file-level entry, so `alchemy/AWS/Lambda/Function` resolves.)

## Design decisions (locked in)

- **D1 — Typed CF host, no duck-typing in v1.** `yield* Worker` +
  `WorkerEnvironment` directly (matches alchemy's own CF bindings). The
  AWS-specific narrowing (`isBindingHost` / `{ env }`) is deferred to §AWS; the
  env-wiring helper is structured so a sibling AWS arm slots in later.
- **D2 — One contract, one Layer per capability in v1** (`*Binding`, CF).
  The `*Http` AWS Layer is the documented extension point (§AWS) — same
  contract, `Effect.provide` swap.
- **D3 — One host identity per host, shared across capabilities.** Deploy-time,
  lazily declare (keyed on `host.LogicalId`): one `iam.ServiceAccount` + one
  `iam.AccessKey` (v2, `secretDeliveryMode: 'INLINE'`, secret persists in
  output). Per-capability **grants** attach separately (storage: bucket policy,
  see D5). No duplicate SA/key per binding.
- **D4 — Runtime clients are HTTP-only.** `s3-lite-client` (already a dep,
  fetch-based, workerd-safe) for S3. The gRPC `api-client` services are
  **deploy-time only**.
- **D5 — Storage grants via AccessPermit, not bucket policy (O4-verified).**
  A bucket policy is a *prop* of the Bucket resource — a binding can't modify
  the user's bucket declaration, so wiring the grant through it would force the
  user to know the lazily-created host-identity group id (circular). Instead the
  binding lazily declares `iam.AccessPermit` on the bucket:
  `{ parentId: hostGroupId, resourceId: bucketId, role }` — a separate resource,
  keyed (host, bucket), with built-in dedup by (parentId, resourceId, role).
  Nebius docs confirm permits and bucket policies both grant object access and
  combine (docs.nebius.com/object-storage/buckets/bucket-policy → "Access
  permits and bucket policies"). No project-level role needed for S3 API access.
  Roles per capability (from the action→role table at
  docs.nebius.com/object-storage/supported-actions):
  - read (`GetObject`/`HeadObject`/`ListObjects`): `storage.viewer`
  - read-write (+`PutObject`/`DeleteObject`/multipart): `storage.editor`
- **D6 — Errors are `Schema.TaggedErrorClass`.** Per AGENTS.md. Runtime failures
  (S3 404/403, endpoint unreachable, missing env) map to tagged errors with
  stable tags, not raw SDK exceptions.
- **D7 — Env names are namespaced** `NEBIUS_*`, unique per (host, capability),
  so multiple bindings on one host don't collide.
- **D8 — Deploy-time provisioning lives in a dynamically-imported module.
  M0-VERIFIED, no fallback needed.** `@grpc/grpc-js` (Node-only) is statically
  imported by `api-client` → `iam.AccessKey` etc., so any binding module that
  statically imports those breaks the workerd bundle. The experiment
  (`spikes/worker-bundle/`, alchemy's own `Bundle.build`):
  - **Guarded dynamic import** (`await import('./host-identity')` inside
    `!__ALCHEMY_RUNTIME__`): the bundle came out **67 KB with zero gRPC
    markers** — `ALCHEMY_DEFINE` folds the guard to `false` and DCE removes the
    entire branch *including the dynamic import*. The gRPC module is
    **physically absent** from the Worker bundle, not merely never-evaluated.
  - **Naive static import** (control): 884 KB bundle with `require("net")` /
    `http2` / `tls` left as externals — would crash workerd at module
    evaluation.
  So: keep `host-identity.ts` behind the guarded dynamic import; no static
  gRPC imports in binding modules (also a lint-able rule for the future).

## Architecture

### File layout

```
modules/resources/shared/bind-host.ts     # D1/D2: bindWorkerEnv — CF env wiring
modules/resources/shared/host-identity.ts # D3+D8: lazy SA+AccessKey+Group+Membership (gRPC, dynamic import)
modules/resources/storage/v1/bindings.ts  # GetObject / PutObject contracts + CF Layer + runtime client
modules/resources/storage/v1/index.ts     # re-export binding namespace members
tests/resources/shared/bind-host.test.ts
tests/resources/storage/v1/bindings.test.ts
tests/resources/storage/v1/bindings.integration.test.ts
examples/bindings.ts                      # Cloudflare Worker stack
README.md                                 # Bindings section
```

Exports (v1 — `*Http` reserved for §AWS):

```ts
Nebius.storage.GetObject          // contract (callable)
Nebius.storage.GetObjectBinding   // Cloudflare Worker Layer
// (future) Nebius.storage.GetObjectHttp  // AWS-family Layer — see §AWS later
// tags: "Nebius.storage.v1.Bucket.GetObject"
```

### `bind-host.ts` — the Worker env half

```ts
/** Pure mapping — unit-testable without a host. */
export const envToWorkerBindings = (
  env: Record<string, string | Redacted.Redacted<string>>,
): WorkerBindingShape[] =>
  Object.entries(env).map(([name, value]) =>
    Redacted.isRedacted(value)
      ? { type: "secret_text", name, text: Redacted.value(value) }
      : { type: "plain_text", name, text: value })

/** Deploy-time: register env bindings on the Worker. No-op at runtime. */
export const bindWorkerEnv = (host: Worker, env: ...) =>
  Effect.fn(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return
    yield* host.bind`NebiusEnv`({ bindings: envToWorkerBindings(env) })
  })
```

The `WorkerBindingShape` union is defined locally (only the `plain_text` /
`secret_text` members we use), so `bind-host.ts` needs no deep alchemy imports.
The AWS arm later is a sibling `bindFunctionEnv(host, env)` → `{ env }`
(§AWS), same call shape — that's the extension point.

### `host-identity.ts` — deploy-time credential provisioning

```ts
export const hostIdentity = (hostLogicalId: string) =>
  Effect.fn(function* () {
    // Runs only in the CLI process (D8). Lazy, stable per host —
    // mirrors AccountApiToken's `${self.LogicalId}Token` keying.
    const sa = yield* Nebius.iam.ServiceAccount(`${hostLogicalId}BindingSA`)
    const key = yield* Nebius.iam.AccessKey(`${hostLogicalId}BindingKey`, {
      serviceAccountId: sa.id, secretDeliveryMode: "INLINE",
    })
    const group = yield* Nebius.iam.Group(`${hostLogicalId}BindingGroup`)
    yield* Nebius.iam.GroupMembership(/* add SA to group */)
    return { serviceAccountId: sa.id, accessKeyId: key.accessKeyId,
             secretAccessKey: key.secretAccessKey }   // Redacted, persists in output
  })
```

Grants are capability-specific (storage: `iam.AccessPermit` on the bucket,
per D5). Imported from
`bindings.ts` via `await import("./host-identity.ts")` inside the guard.

### `storage/v1/bindings.ts` — storage bindings (CF)

```ts
export interface GetObject extends Binding.Service<
  GetObject, "Nebius.storage.v1.Bucket.GetObject",
  (bucket: NebiusBucket) => Effect.Effect<
    (request: { key: string }) => Effect.Effect<GetObjectResult, GetObjectError>
  >
> {}

export const GetObject = Binding.Service<GetObject>("Nebius.storage.v1.Bucket.GetObject")

export const GetObjectBinding = Layer.effect(GetObject, Effect.gen(function* () {
  const host = yield* Worker
  return Effect.fn(function* (bucket: NebiusBucket) {
    // Attribute access is lazy: `bucket.name` is an Effect yielding an
    // Accessor — double-yield to materialize (same as AWS S3 `bucket.bucketName`).
    const BucketName = yield* yield* bucket.name
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      // DCE'd out of the Worker bundle (M0-verified) — never evaluated on workerd
      const { hostIdentity } = yield* Effect.promise(() => import("./host-identity.ts"))
      const identity = yield* hostIdentity(host.LogicalId)
      // Grant: AccessPermit on the bucket for the host-identity group (D5).
      // The AccessKey secret is wrapped in Redacted → deployed as secret_text.
      yield* Iam.AccessPermit(`${host.LogicalId}${bucket.LogicalId}Access`, {
        parentId: identity.groupId,
        resourceId: yield* yield* bucket.id,
        role: "storage.editor",   // read-write; "storage.viewer" for read-only
      })
      yield* bindWorkerEnv(host, "Nebius.storage.GetObject", {
        NEBIUS_S3_ENDPOINT: storageEndpoint(region),   // storage.<region>.nebius.cloud
        NEBIUS_ACCESS_KEY_ID: identity.awsAccessKeyId,
        NEBIUS_SECRET_ACCESS_KEY: Redacted.make(identity.secretAccessKey),
        NEBIUS_BUCKET_NAME: BucketName,
        NEBIUS_REGION: region,
      })
    }
    return Effect.fn("Nebius.storage.Bucket.GetObject")(function* (request) {
      // runtime: s3-lite-client from WorkerEnvironment env; map errors (D6)
    })
  })
}))
```

`PutObject` mirrors it. Runtime client is built once per binding from env values
(`s3-lite-client` `S3Client` with `{ endpointUrl, region, accessKeyId,
secretAccessKey }` — path-style for Nebius, verify in M0).

## Milestones

### M0 — Spike & verification (no code committed)

**Batch 1 — desk checks: DONE**

- [x] Imports resolve + type-check (verified in `spikes/m0/imports.ts`, tsc 7.0.2
      clean): `alchemy/Binding` (`Binding.Service`, `Binding.Host`);
      `alchemy/Cloudflare/Workers` (`Worker`, `WorkerEnvironment`, `isWorker`,
      `WorkerBinding`). Full pattern type-checks: contract, `Layer.effect` with
      `yield* Worker`, `host.bind\`...\`({ bindings: [plain_text/secret_text] })`,
      `__ALCHEMY_RUNTIME__` guard, `isWorker` narrowing.
      **Finding:** deep CF subpaths don't resolve — import from the namespace
      index (`alchemy/Cloudflare/Workers`), never `.../Workers/Worker`.
- [x] `s3-lite-client` is workerd-safe (static analysis): zero runtime deps;
      global `fetch`; WebCrypto `crypto.subtle` for SigV4; no Node builtins
      anywhere. Path-style by default (`pathStyle ?? true`); accepts full URL
      `endPoint` (e.g. `https://storage.eu-north1.nebius.cloud`) + `region` +
      key/secret. → O2 resolved at the static level.
- [x] `@grpc/grpc-js` is Node-only (D8 premise confirmed): `net`/`http2`/`tls`/
      `dns`/`zlib` across ~12 build files, `engines: node >= 12.10.0`. Cannot
      evaluate on workerd — the gRPC module graph must not reach the bundle.

**Batch 2 — build-pipeline experiments: DONE**

- [x] `bucket.name` is a lazy, double-yielded attribute in a binding impl
      (`yield* yield* bucket.name` — first yield gives the `Accessor`, second
      materializes; matches AWS S3 `bucket.bucketName`). Typechecked in
      `spikes/m0/imports.ts`; runtime probe confirms laziness (resolution
      requires a Stack context).
- [x] **D8 decisive experiment** (`spikes/worker-bundle/bundle.mts`, alchemy's
      own `Bundle.build` pipeline): guarded dynamic import of a module that
      statically imports `@grpc/grpc-js` → emitted Worker bundle is **67 KB,
      zero gRPC markers** (guard folded via `ALCHEMY_DEFINE`, dead branch +
      dynamic import DCE'd out entirely). Naive static-import control →
      884 KB bundle with `net`/`http2`/`tls` as unresolved externals (workerd
      crash). → D8 confirmed, fallback not needed.
- [ ] Confirm `secret_text`/`plain_text` binding data is honored by `alchemy
      dev`'s local worker provider (env present in `WorkerEnvironment`) —
      carried into M3 (the `alchemy dev` e2e exercise, needs the scratch stack)
- [ ] Verify `AccessKey` output secret survives a second deploy (state restore)
      — carried into M3 (integration lifecycle test) or an M2 unit test
- [ ] **D8 validation**: prototype the `await import()`-behind-guard pattern;
      confirm the workerd bundle either (a) omits the gRPC module or (b) never
      evaluates it at runtime; confirm `@grpc/grpc-js` is genuinely
      unusable/absent in a deployed Worker (if it were usable, D8 weakens to a
      style rule)
- [ ] Confirm `s3-lite-client` runs on workerd and supports path-style
      addressing against `storage.<region>.nebius.cloud`
- [ ] Confirm `secret_text`/`plain_text` bindings are honored by the local
      worker provider in `alchemy dev` (env present in `WorkerEnvironment`)
- [ ] Verify `AccessKey` output secret survives a second deploy (state restore)
      — already implied by `precreate` + preserve-from-output, but prove it

### M1 — Worker host wiring core — DONE

- [x] `modules/resources/shared/bind-host.ts`: `envToWorkerBindings` (pure) +
      `bindWorkerEnv` (`Effect.fn` with args on the generator, `__ALCHEMY_RUNTIME__`
      guard). Uses the real `Worker`/`WorkerBinding` types from
      `alchemy/Cloudflare/Workers` (resolves O7 — no local union needed).
      `host.bind(sid, { bindings })` string form works.
- [x] `modules/resources/shared/host-identity.ts`: `HostIdentity` (Schema.Class)
      + lazy SA + AccessKey + Group + GroupMembership provisioning. Effect.fn
      requirement includes the four resource `Provider` tags. D8-boundary
      comment in place.
      **Lesson:** `Schema.Redacted` decode expects an already-Redacted value and
      encodes to the "<redacted>" marker — wrong fit for a plain-object model.
      Decision: `secretAccessKey` is plain `Schema.String` in the model; Redacted
      wrapping happens at the env boundary (M2 passes `Redacted.make(...)` to
      `bindWorkerEnv`, which maps it to `secret_text`). HostIdentity is
      ephemeral (never persisted), so this is safe.
- [x] Unit tests `tests/resources/shared/{bind-host,host-identity}.test.ts`
      (network-free, 10 pass): plain vs secret mapping, Redacted→secret_text,
      deploy registration + runtime no-op, HostIdentity decode + rejection.
- [x] `bun run check` clean; `bun test` green. (Lint: 3 new
      `no-underscore-dangle` warnings on `__ALCHEMY_RUNTIME__` — same warning
      class the baseline already carries for `_tag`.)

### M2 — Storage bindings — DONE

- [x] O4 resolved: `storage.viewer` (read) / `storage.editor` (read-write)
      from the action→role table; grant via `iam.AccessPermit` on the bucket
      (D5 updated).
- [x] `modules/resources/storage/v1/bindings.ts`: `GetObject` + `PutObject`
      contracts; `GetObjectBinding` / `PutObjectBinding` CF Layers
      (hostIdentity → grantBucketAccess → bindWorkerEnv → s3-lite-client
      runtime client reading `WorkerEnvironment`; client memoized per binding;
      bucket name via the client's default-bucket option, so the request type
      is just `{ key }`). Re-exported from `storage/v1/index.ts` as
      `Nebius.storage.GetObject` etc.
      **Key type-system finding:** `Binding.Service`'s contract types impl fns
      with `R = never`, so `Layer.effect` rejects deploy-time Provider
      requirements on the per-bucket fn. Resolved with an encapsulated
      `unrequiring` cast in `host-identity.ts` (Provider requirements are real
      at deploy time but satisfied by the stack's provider collection) — this
      matches alchemy's own bindings exactly (R2 `BucketHttp` d.ts shows
      `Effect<..., never, never>` despite declaring `AccountApiToken` inside).
      Also: `Schema.NonEmptyString` is the `String` wrapper type, not primitive
      `string`; `ConfigError` from a `Config` read is defected via
      `Effect.orDie` (per house style); `noUncheckedIndexedAccess` requires
      literal-key env record typing.
- [x] Tagged errors (D6): `ObjectNotFound`, `BucketNotFound`, `AccessDenied`,
      `InvalidCredentials`, `S3Error`; `toStorageError` maps s3-lite
      `ServerError` codes (NoSuchKey/NoSuchBucket/AccessDenied) + catch-alls.
- [x] Unit tests `tests/resources/storage/v1/bindings.test.ts` (network-free):
      contracts defined, tagged-error catchability, `readS3Env` complete +
      missing-env failure, `toStorageError` mapping matrix. 24 tests total.
- [x] `bun run check` clean; `bun test` green.

### M3 — Integration tests — BLOCKED on a platform behavior (findings below)

Shipped:

- [x] `Group` provider: missing `news = news || {}` guard before validation (a
      pre-existing bug exposed by no-props deploys).
- [x] `GroupMembership` provider + api-client: `metadata.name` is PROHIBITED by
      the API (verified live + CLI) — now omitted.
- [x] `X-Idempotency-Key` header added to the transport (matches the official
      gosdk, which sends it on every request).
- [x] The docs' grant path identified and VERIFIED: SA → tenant's default
      `editors` group resolves INSTANTLY through our client (the group carries
      the `editor` general role — no AccessPermit / bucket policy needed).

**BLOCKER — Nebius treats our grpc-js client's IAM creates differently from
its own gosdk/CLI.** Definitive experiment: a small Go program using the
**gosdk itself** (the CLI's exact library), with the same token, creates an SA,
membership, and access key **all instantly** — while our client (byte-identical
request body — verified with wire dumps on both sides; same `Authorization:
Bearer` + `X-Idempotency-Key` headers; same endpoint; same operation
semantics; tried the gosdk's `grpc-go` user-agent — no effect) cannot resolve
even a CLI-created SA for the AccessKey service within seconds (works after
~30-60s). The gosdk's behavior is server-side, invisible at any documented
layer. This also breaks the project's pre-existing
`access-key.integration.test.ts`.

Consequence: the binding's identity SA must be created via the official
CLI/gosdk path (option 2c — shell out to `nebius iam service-account create`;
the docs' own workflow). The integration test that proves the full grant + S3
round-trip path is written but removed from the suite until the platform
quirk is resolved or the 2c provisioning is implemented.

### M4 — Docs & examples

- [ ] `examples/bindings.ts`: Cloudflare Worker stack consuming
      `Nebius.storage.GetObject` (the Goal snippet, compilable)
- [ ] README "Bindings" section: what they are, supported host (Cloudflare
      Worker) + roadmap note (AWS), one-line usage, env var reference
- [ ] Final: `bun run check` clean, `bun test` green, `SLOW_TESTS=1 bun test`
      passes with credentials

## Adding AWS hosts later

Everything below is **not built in v1** — it's the documented path, and the
design above leaves the seams for it. When AWS support lands, it's additive:
new files + one new Layer per capability, zero changes to contracts, runtime
clients, or `host-identity.ts`.

### What changes

| Aspect | Cloudflare (v1) | AWS (later) |
|---|---|---|
| Host access | `yield* Worker` (typed) | `yield* Binding.Host` + `isBindingHost` (checks `Type` ∈ 5 AWS host types) |
| Bind data | `{ bindings: [plain_text/secret_text] }` | `{ env: {...} }` (policyStatements omitted — Nebius auth isn't IAM) |
| Env wiring | `bindWorkerEnv` | sibling `bindFunctionEnv(host, env)` — same call shape |
| Runtime client | s3-lite-client (fetch, workerd-safe) | **same** — s3-lite-client runs on Node too; optionally swap for gRPC api-client (Node-only) |
| Deploy-time provisioning | `host-identity.ts` via dynamic import (D8) | same module works (CLI is Node); static import becomes safe on Lambda |
| Dev/local | workerd local worker provider | none — real Lambda deploys |

### AWS-specific things to verify when adding

1. **One new Layer per capability**: `GetObjectHttp` / `PutObjectHttp` =
   `Layer.effect(GetObject, ...)` pushing `{ env }`; users swap
   `Effect.provide(GetObjectHttp)` instead of `GetObjectBinding`. Same contract
   — no call-site changes.
2. **Lazy `Output`s in `binding.data.env`**: whether Lambda's env merge
   (`Function.ts:938`) resolves `Output` values or needs pre-resolved strings
   (fallback: resolve in the impl, as sketched for CF).
3. **Env value packing**: Lambda env values pass through
   `packEnvValue`/`unpackEnvValue` (`RuntimeContext.ts`) — confirm strings /
   Redacted values round-trip (redact before pushing).
4. **Merge order**: `{...bindingEnv, ...news.env}` — user's `env` prop wins;
   document for the `*Http` layers.
5. **No `policyStatements` needed**: Nebius auth is SA/AccessKey-based; the
   Lambda role needs zero AWS permissions for Nebius calls.
6. **gRPC at runtime is optional on AWS**: `@grpc/grpc-js` runs fine in a
   Lambda (Node), so future bindings over KMS/mysterybox gRPC could skip HTTP.
   Storage keeps s3-lite-client for parity.
7. **Testing**: no local emulation — data-shape unit tests (the pure
   `envToWorkerBindings` sibling) + a real Lambda integration deploy.

### Already in place for a smooth landing

- Contracts and runtime clients are host-agnostic (D2) — the Layer is the only
  host-specific surface.
- `bind-host.ts` isolates host wiring behind one helper with a documented
  sibling for the AWS arm.
- `host-identity.ts` is host-independent (keyed on a string logical id, not a
  host type) — reusable as-is.
- Exports reserve the `*Http` names (documented, not yet implemented).

## Testing strategy

- **Unit (network-free, default `bun test`)**: pure `envToWorkerBindings`
  mapping; contract tag identity; error mapping from s3-lite errors. Uses
  existing `tests/helpers/provider.ts` style (`runEffect`, no cloud).
- **Integration (`SLOW_TESTS=1`)**: deploy-time provisioning + runtime client
  round-trip against real Nebius, gated by `tests/helpers/gate.ts`
  (`integrationTest`), cleaned up with `safeDestroy()`.
- **Worker end-to-end**: `alchemy dev` local worker provider (real Nebius
  bucket, workerd execution) — exercises the full `secret_text`/`plain_text`
  path without needing Cloudflare credentials. Real CF deploy = stretch.
- AWS paths (env merge, IAM) are exercised later with a real Lambda deploy
  (§AWS); data shapes are unit-tested regardless.

## Open questions / risks

| # | Question | Impact | Resolution target |
|---|---|---|---|
| O1 | Does `alchemy dev`'s local worker provider honor `secret_text`/`plain_text` binding data? | e2e testability without CF creds | M0 spike |
| O2 | Does `s3-lite-client` work on workerd + path-style Nebius S3? | Storage runtime client | M0 spike |
| O3 | Does the workerd bundle tolerate (omit or never-evaluate) the guarded `await import()` of the gRPC module? | D8 approach | M0 spike; fallback documented in D8 |
| O4 | ~~Exact Nebius role names + grant shape~~ **RESOLVED**: `storage.viewer`
    (read) / `storage.editor` (read-write) from the action→role table;
    grant via `iam.AccessPermit` on the bucket (D5) — permits and bucket
    policies both grant object access and combine | Storage grant | D5 updated |
| O5 | `AccessKey` output secret survives second deploy (state restore) | Env re-injection across deploys | M0 spike |
| O6 | One shared host identity vs per-capability keys | Least privilege | D3 decided: shared identity, per-capability grants |
| O7 | `WorkerBindingShape` local union drifts from alchemy's `WorkerBinding` wire type on upgrade | Bundle correctness | M0 spike pins types; keep local union minimal |

## Out of scope (noted for later)

- **AWS Lambda/ECS/EKS support** — see [§Adding AWS hosts later](#adding-aws-hosts-later)
- AI endpoint bindings (`ChatCompletions`) — endpoints are expensive/slow to
  deploy, impractical to test; revisit when testing is cheap
- KMS Encrypt/Decrypt, mysterybox GetSecretValue, DNS record bindings — same
  pattern once M2/M3 land
- Event sources / sinks
- `*Local` dev emulation layers
- Upstreaming the env-binding helper to `alchemy` as a shared capability
