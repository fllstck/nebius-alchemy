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
  }).pipe(Effect.provide(Nebius.storage.GetObjectHttp)),
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
- No AI endpoint bindings in the first pass — **shipped since, see
  [AI_BINDINGS.md](AI_BINDINGS.md)** (ChatCompletions, mock-first tests)
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

Exports (v1 — `*Http` = HTTP-backed credential binding; the AWS arm reserves
`*FunctionHttp` for §AWS):

```ts
Nebius.storage.GetObject          // contract (callable)
Nebius.storage.GetObjectHttp      // Cloudflare Worker Layer
// (future) Nebius.storage.GetObjectFunctionHttp  // AWS-family Layer — see §AWS later
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

export const GetObjectHttp = Layer.effect(GetObject, Effect.gen(function* () {
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

> Spike fixtures (`spikes/m0/`, `spikes/worker-bundle/`) were **deleted after M0** per plan — all findings and results below are self-contained.

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
      contracts; `GetObjectHttp` / `PutObjectHttp` CF Layers
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

### M3 — Integration tests — DONE ✅ (see below for the resolved blocker)

Both integration tests green and stable (3/3 consecutive full runs):
- identity lifecycle: SA → editors-group membership → v2 access key
- **S3 round-trip via s3-lite-client** — the binding chain validated end-to-end
  against real Nebius S3 (putObject → getObject → deleteObject)

Stretch (not yet done): `alchemy dev` local-worker e2e (workerd execution of
the `secret_text`/`plain_text` binding path) — needs no CF credentials, but
not required to consider M3 done.

**The weeks-long "NOT_FOUND on freshly-created IAM resources" blocker was a
TEST-PATTERN bug in our own integration tests, not the Nebius backend, not the
api-client, and not the alchemy harness runtime.**

Root cause, found by bisecting the harness step by step:

1. The alchemy **scratch stack re-plans the whole stack on every
   `stack.deploy(...)` call** and DELETES resources not present in the new
   effect (they're treated as "removed from the stack"). Our tests called
   `stack.deploy(SA)`, then `stack.deploy(Membership)`, then
   `stack.deploy(Key)` — each later deploy **deleted the earlier resources**
   mid-test. The "phantom SAs" were deleted SAs; the access-key creates
   failed because the SA genuinely didn't exist anymore; the membership delete
   NOT_FOUNDs were cascades of the SA deletion (Nebius removes a SA's group
   memberships/access keys server-side).
2. The access-key provider's `precreate` runs before ref resolution (alchemy
   passes raw props to precreate — `waitForDeps`/`Output.evaluate` only happen
   before `reconcile`), so the key can't be created in the same deploy as a
   not-yet-existing SA. The dependency must be deployed first.
3. Deletes were not idempotent: `makeCrudDelete` propagated NOT_FOUND, so a
   destroy whose SA was deleted before its (server-side cascaded) children
   failed. Fixed: NOT_FOUND on delete = already gone = success (standard IaC
   contract).

**The correct test pattern** (used by the reinstated integration tests):

```ts
// Stage 1: deploy the dependency alone so its id is concrete.
const { sa } = yield* stack.deploy(
  Effect.gen(function* () {
    const sa = yield* Nebius.iam.ServiceAccount('SA', { description: 'x' })
    return { sa }
  }),
)
// Stage 2: RE-DECLARE the full resource set (the SA becomes a noop — NOT
// deleted) and reference it via the in-effect resource instance (`.id`).
const { key } = yield* stack.deploy(
  Effect.gen(function* () {
    const sa = yield* Nebius.iam.ServiceAccount('SA', { description: 'x' })
    const key = yield* Nebius.iam.AccessKey('Key', { serviceAccountId: sa.id })
    return { key }
  }),
)
```

Shipped fixes in this milestone:

- [x] **Idempotent deletes**: `makeCrudDelete` swallows `GrpcError` code 5
      (NOT_FOUND) — a delete of an already-gone resource is success. Applies
      to every CRUD resource provider.
- [x] **`bindings.integration.test.ts` reinstated + completed** — three tests,
      stable across repeated runs:
      1. *Identity lifecycle* (SA → default editors-group membership → v2
         access key with INLINE secret) — create + destroy.
      2. *S3 round-trip*: the full binding chain — bucket + SA → editors
         grant → access key → **s3-lite-client** (byte-for-byte the client the
         binding Layer builds: full-URL `endPoint`, path-style,
         region-scoped key) → `PutObject`/`GetObject` round-trip against real
         Nebius S3, object cleaned before bucket destroy.
      3. *Binding impl end-to-end (mocked host)*: runs the REAL
         `GetObjectHttp`/`PutObjectHttp` layers with a mocked `Worker`
         host (via the `Self` service) — asserts the deploy-time wiring
         (hostIdentity chain → both AccessPermits → the 5 `NEBIUS_S3_*` env
         bindings recorded on the mock) and runs a PUT+GET round-trip through
         the binding's own runtime client (readS3Env → s3-lite-client) against
         real Nebius S3.
- [x] **`AccessPermit` `metadata.name` removal** — the API rejects it (same
      rule as GroupMembership); provider + `CreateAccessPermitInput` omit it.
- [x] **Access key created in `reconcile`, not `precreate`** — precreate
      receives raw props (unresolved refs), so the key couldn't be declared in
      the same deploy as its SA; reconcile runs after ref resolution, so the
      one-deploy hostIdentity chain works (secret capture unchanged).
- [x] **Pre-existing `access-key.integration.test.ts` fixed** with the staged
      pattern — 3/3 green (it was broken by the same partial-redeploy bug).
- [x] `Group` provider `news = news || {}` guard; `GroupMembership`
      `metadata.name` removal; `X-Idempotency-Key` header — from the earlier
      bisect.
- [x] `GroupMembership` bounded NOT_FOUND retry on create (the member/parent
      may be propagating) — retained.

Diagnostic dead ends conclusively ruled out along the way (all reproduced with
byte-identical requests): server retry hints (the `grpc-status-details-bin`
carries `retry_type: NOTHING` — the server explicitly says don't retry),
channel lifecycle/reuse, fresh-channel-in-process, token identity, alchemy
labels, 63-char names, membership interference, v1-vs-v2 access-key service,
full-vs-minimal providers layer, bun-test-vs-bun-script (a plain bun test with
the api-client passes). The single variable that always correlated was the
number of `stack.deploy` calls.

### M4 — Docs & examples — DONE ✅ (with a follow-up: see “M4 e2e findings” below)

- [x] `examples/bindings.ts`: Cloudflare Worker stack consuming
      `Nebius.storage.GetObject`/`PutObject` — the Goal snippet shape, using
      the **Effect-native Worker form** (`Cloudflare.Worker(id, props, impl)`, where
      the impl's `WorkerServices` inherently satisfy the binding layers'
      `Worker | WorkerEnvironment` requirements — the stack-level `Alchemy.Stack`
      Req can't include those services). Deploy-time grant + env wiring + a
      GET/POST `fetch` handler demonstrating the runtime clients. Compiles
      clean (`bun run check`, 0 errors). Gotchas discovered: `Effect.provide`
      has only a single-layer curried overload (chain or `Layer.mergeAll`);
      Effect-native `fetch` is an `HttpEffect` (request via
      `yield* HttpServerRequest`, not a function arg).
- [x] README "Bindings" section: what they are, Cloudflare-first + AWS
      roadmap note, one-line usage snippet, contracts table,
      `NEBIUS_S3_*` env reference; `examples/bindings.ts` row in the
      Examples table.
- [x] Final: `bun run check` clean (0 errors, 12 baseline warnings),
      `bun test` green (385), `SLOW_TESTS=1` integration green for the
      bindings + access-key + bucket suites (4/4).

### M4 e2e findings (the `alchemy dev` stretch — deploy-time wiring RESOLVED; runtime blocked)

**UPDATE — PRODUCTION VERIFIED ✅ (real Cloudflare deploy).** The example
deploys to real Cloudflare + real Nebius and serves the full round-trip:
`POST /` (putObject) and `GET /` (getObject) through the binding's runtime
client on Cloudflare workerd against Nebius S3 — bucket verified server-side
with the object present. Two more real bugs found + fixed along the way:
- **Duplicate binding names**: every capability injected the same `NEBIUS_S3_*`
  env names → Cloudflare rejected the upload (`Binding name 'NEBIUS_ACCESS_KEY_ID'
already in use`). Fixed with `registerEnvOnce` — the shared host-identity env
  is registered once per host (deduped by host + name; module-level set ≈
  per-deploy since each deploy runs in a fresh process).
- **The remote provider requires an entry**: the Effect-native worker needs
  `main` pointing at its own file for real deploys (the dev local provider
  accepted impl-only). The example now uses a separate entry
  (`examples/bindings-worker.ts`) with `main: import.meta.url` there — the
  entry imports only contracts + effect runtime, not the stack machinery.

Earlier findings (still true, context):

Running `alchemy dev examples/bindings.ts` (workerd local-worker e2e) surfaced
THREE issues. Two are fixed and the deploy-time wiring is now proven in a real
dev deploy; the third (the workerd runtime itself) remains with the alchemy
maintainers.

1. **A REAL bug in the bindings' deploy-time wiring — FIXED.** The deploy
   failed with `Error: Expected string at ["serviceAccountId"]` from
   `new HostIdentity(...)`: the impl resolved lazily-declared resource
   outputs via `yield* yield* sa.id`, which returns `undefined` in the
   binding-impl context (the ambient `RuntimeContext` during a resource
   lifecycle is not the resolve context). The alchemy-blessed pattern (R2
   `BucketHttp` precedent): pass the **Output/Accessor expressions through**
   — never resolve inline via double-yield.
   Applied: `HostIdentity` now holds Outputs; `grantBucketAccess`/
   `bindingEnv` pass Outputs into AccessPermit props + `bindWorkerEnv` env
   values (resolved by `Output.evaluate` at apply); `bind-host.ts` accepts
   Output env values. Validated: the one-deploy hostIdentity chain
   (SA+group+membership+key) deploys and destroys cleanly, and the
   **mocked-host impl test** (`bindings.integration.test.ts` test 3) runs the
   real `GetObjectHttp`/`PutObjectHttp` layers — deploy-time wiring
   (hostIdentity → grant → env bindings recorded on a mocked `Worker` host
   via `Self`) + the runtime client (PUT+GET through the binding against real
   Nebius S3).
2. **`AccessPermit` sent `metadata.name` — FIXED.** The API rejects it
   (`3 INVALID_ARGUMENT: metadata.name is not supported`, same rule as
   GroupMembership). Provider + `CreateAccessPermitInput` now omit it.
3. **Access-key creation moved from `precreate` to `reconcile`.** A
   precreate receives RAW props (refs unresolved), so the key could never be
   declared in the same deploy as its SA (the hostIdentity chain). Reconcile
   runs after `waitForDeps`/`Output.evaluate` — refs resolve — the one-deploy
   chain works, secret capture unchanged.
4. **`examples/bindings.ts`: no `main` for an Effect-native Worker.**
   `main: import.meta.url` bundled the whole stack module into the worker
   script (dragging in the workerd lib whose `require.resolve` shim fails
   under workerd — `Uncaught TypeError: e.resolve is not a function`). The
   impl IS the entry — omit `main`.
5. **The dev-deploy result**: the full wiring now executes against real
   Nebius in `alchemy dev` — hostIdentity chain, bucket, both AccessPermits,
   the Worker resource, `workerUrl` up. The bindings' deploy-time wiring is
   PROVEN.

**Remaining (alchemy maintainers)**: the workerd RUNTIME doesn't serve
requests. The RPC bridge connection dies (`CLOSE_WAIT`), the watch restarts
sidecars on new ports while workerd stays on the dead bridge, and it does not
respawn after a kill — `curl` hangs. Reproducer: `CI=1
CLOUDFLARE_API_TOKEN=<32-hex> CLOUDFLARE_ACCOUNT_ID=<32-hex> bun
node_modules/alchemy/bin/alchemy.js dev examples/bindings.ts` (the local
worker needs a resolvable Cloudflare profile — `~/.alchemy/profiles.json`
gained `"Cloudflare": { "method": "env" }`; the token is never actually
used for local workerd).

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

1. **One new Layer per capability**: `GetObjectFunctionHttp` /
   `PutObjectFunctionHttp` =
   `Layer.effect(GetObject, ...)` pushing `{ env }`; users swap
   `Effect.provide(GetObjectFunctionHttp)` instead of `GetObjectHttp`. Same
   contract — no call-site changes. (Named for alchemy's "Function" host
   family — `isBindingHost` checks Lambda.Function | ECS.Task | ECS.Service |
   EKS.Deployment | EKS.Job — to distinguish them from the CF `*Http` layers.)
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
- AI endpoint bindings: shipped — see [AI_BINDINGS.md](AI_BINDINGS.md);
  the real-endpoint e2e (SLOW_TESTS) is the remaining milestone, the runtime
  client is covered by local-mock tests
- KMS Encrypt/Decrypt, mysterybox GetSecretValue, DNS record bindings — same
  pattern once M2/M3 land
- Event sources / sinks
- `*Local` dev emulation layers
- Upstreaming the env-binding helper to `alchemy` as a shared capability
