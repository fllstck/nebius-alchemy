# Bindings — cross-cloud typed clients for Nebius resources

Implementation plan for adding Alchemy **Bindings** to `@fllstck/nebius-alchemy`:
typed runtime clients that users bind to **their own** hosts (Cloudflare Worker,
AWS Lambda/ECS/EKS) — no Nebius Function host.

## Goal

A user with their own host can write:

```ts
// their Cloudflare Worker
export default Cloudflare.Worker("Api", { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket("assets")
    const getObject = yield* Nebius.storage.Bucket.GetObject(bucket)
    const chat = yield* Nebius.ai.Endpoint.ChatCompletions(model)
    return { fetch: /* uses getObject and chat */ }
  }).pipe(Effect.provide(Nebius.storage.Bucket.GetObjectBinding)),
)
```

One line derives: (1) deploy-time credential minting + least-privilege grant on
Nebius, (2) env/config injected into the user's host, (3) a typed runtime client.

## Non-goals

- No `Nebius.compute.Function` host / custom runtime (explicitly out of scope)
- No event sources or sinks (no Nebius-native pub/sub to subscribe to)
- No KMS / mysterybox / DNS bindings in the first pass (same pattern, later)
- No local-dev emulation layers (`*Local`) — dev runs against the real cloud
- Not proposing changes to `alchemy` itself (though `bindHostEnv` is a candidate
  for upstreaming later)

## Context — verified mechanics (from `node_modules/alchemy@2.0.0-beta.67`)

- A binding = contract (`Binding.Service<Self, Tag, Shape>`) + impl Layer.
  Contract is callable at the call site; impl is provided via `Effect.provide`.
- `Binding.Host` (= `Self`) resolves the host resource at deploy time, gated by
  `if (!globalThis.__ALCHEMY_RUNTIME__)`. At runtime the host is absent.
- `host.bind(data)` (Resource.ts) only pushes `{ sid, data }` onto
  `stack.bindings[hostFqn]`. **The host provider does all the linking**:
  - AWS Lambda/ECS/EKS merge `data.env` into function config and
    `data.policyStatements` into IAM (`Function.ts:938`); user `env` prop wins.
  - Cloudflare Worker merges `data.bindings` (`WorkerBinding[]`) into script
    metadata; `secret_text` entries deploy as Cloudflare secrets.
- **The data shape is per host family** — no universal env shape exists:
  - AWS family (5 hosts): `{ env, policyStatements }` — narrowed by
    `isBindingHost` (checks `Type` ∈ Lambda.Function | ECS.Task | ECS.Service |
    EKS.Deployment | EKS.Job).
  - Cloudflare: `{ bindings: [{ type: "plain_text"|"secret_text", name, text }] }`
    — narrowed by `isWorker`.
- Precedent for the whole approach: Cloudflare `AccountApiToken` — a resource
  that (a) is declared **lazily from inside a binding impl**
  (`yield* Token(`${self.LogicalId}Token`)`), (b) persists a **one-time plaintext
  secret in its output** so later deploys re-read it. Our `iam.v2.AccessKey`
  already does (b) via `precreate` + preserve-from-output.
- Public import surface: `alchemy/Binding` subpath works (`./*` → `src/*.ts`);
  root exports `BindingService` only. `isBindingHost` / `isWorker` exist but live
  in deep implementation modules — see decision D1.

## Design decisions (locked in)

- **D1 — Duck-typed host narrowing, no deep alchemy imports.** Do NOT import
  `alchemy/AWS/Lambda/Function` or `alchemy/Cloudflare/Workers/Worker` into
  binding modules: they drag AWS SDK / Cloudflare runtime code into bundles and
  cross-contaminate Worker vs Lambda artifact builds. Instead, replicate the
  tiny checks locally against `host.Type` (`"AWS.Lambda.Function" | "AWS.ECS.Task"
  | "AWS.ECS.Service" | "AWS.EKS.Deployment" | "AWS.EKS.Job"` vs
  `"Cloudflare.Worker"`), and cast `host.bind` through one encapsulated helper
  (approved `any`-encapsulation exception, same spirit as `callMethod<T>()`).
- **D2 — One contract, two Layers per capability**, mirroring Cloudflare R2's
  `ReadWriteBucketBinding` / `ReadWriteBucketHttp` split:
  - `*Http` Layer → AWS family (`{ env }`, no policyStatements — Nebius auth is
    not IAM)
  - `*Binding` Layer → Cloudflare (`{ bindings: [plain_text/secret_text] }`)
  Both satisfy the same contract; users pick by host. A single branching Layer
  is rejected: two Layers keep type-level enforcement and bundle hygiene clean.
- **D3 — One host identity per host, shared across capabilities.** Deploy-time,
  lazily declare (keyed on `host.LogicalId`): one `iam.ServiceAccount` + one
  `iam.AccessKey` (v2, `secretDeliveryMode: 'INLINE'`, secret persists in
  output). Per-capability **grants** attach separately (bucket policy group grant
  for storage, see D5). No duplicate SA/key per binding.
- **D4 — Runtime clients are HTTP-only.** `s3-lite-client` (already a dep,
  fetch-based) for S3; plain `fetch` for OpenAI-compatible AI endpoints. The
  gRPC `api-client` services are **deploy-time only** — `@grpc/grpc-js` must not
  appear in the runtime path of a binding module (Worker bundles would break).
- **D5 — Storage grants via bucket policy, not AccessPermit.** Nebius
  `AccessPermit` requires a group parent and is project/group-scoped. The bucket
  already supports `bucketPolicy.rules[].groupId` grants (paths + roles +
  anonymous) — closest thing to per-bucket least privilege. Host identity:
  SA → group (`iam.Group`) → `iam.GroupMembership`; grant: bucket policy entry
  `{ paths: ["*"], roles: ["storage.editor"], groupId }`. Verify role names in
  M2 (open question O4).
- **D6 — Errors are `Schema.TaggedErrorClass`.** Per AGENTS.md. Runtime failures
  (S3 404/403, endpoint unreachable, missing env) map to tagged errors with
  stable tags, not raw SDK exceptions.
- **D7 — Env names are namespaced** `NEBIUS_*` and unique per (host, capability)
  so multiple bindings on one host don't collide.

## Architecture

### File layout

```
modules/resources/shared/bind-host.ts     # D1: host narrowing + bindHostEnv helper
modules/resources/shared/host-identity.ts # D3: lazy SA + AccessKey + group grant
modules/resources/storage/v1/bindings.ts  # GetObject / PutObject contracts + 2 Layers each
modules/resources/ai/v1/bindings.ts       # ChatCompletions contract + 2 Layers
modules/resources/storage/v1/index.ts     # re-export binding namespace members
modules/resources/ai/v1/index.ts          # re-export binding namespace members
tests/resources/shared/bind-host.test.ts
tests/resources/storage/v1/bindings.test.ts
tests/resources/ai/v1/bindings.test.ts
tests/resources/storage/v1/bindings.integration.test.ts
examples/bindings.ts
README.md                                 # Bindings section
```

Exports (parallel to `AWS.S3.GetObject` naming):

```ts
Nebius.storage.GetObject          // contract (callable)
Nebius.storage.GetObjectHttp      // AWS-family Layer
Nebius.storage.GetObjectBinding   // Cloudflare Layer
// tags: "Nebius.storage.v1.Bucket.GetObject", "Nebius.ai.v1.Endpoint.ChatCompletions"
```

### `bind-host.ts` — the shared host half

```ts
/** Pure mapping — unit-testable without a host. */
export const envToHostBindingData = (
  hostType: string,
  env: Record<string, string | Redacted.Redacted<string>>,
): { kind: "aws"; data: { env: Record<string, string> } }
  | { kind: "cloudflare"; data: { bindings: WorkerBindingShape[] } }
  | { kind: "unsupported"; hostType: string }

/** Deploy-time: register env on whatever host is present. Dies on unknown hosts. */
export const bindHostEnv = (env: ...) =>
  Effect.fn(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return  // no host at runtime
    const host = yield* Binding.Host
    ...narrow via host.Type, yield* host.bind`...`(data)
  })
```

`Redacted` values map to `secret_text` on Cloudflare / stay as-is in AWS `env`.

### `host-identity.ts` — deploy-time credential provisioning

```ts
export const hostIdentity = (hostLogicalId: string) =>
  Effect.fn(function* () {
    // Lazy, stable per host — mirrors AccountApiToken's `${self.LogicalId}Token`
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

Grants are capability-specific (storage: bucket policy; ai: none beyond token).

### `storage/v1/bindings.ts` — first capability

```ts
export interface GetObject extends Binding.Service<
  GetObject, "Nebius.storage.v1.Bucket.GetObject",
  (bucket: NebiusBucket) => Effect.Effect<
    (request: { key: string }) => Effect.Effect<GetObjectResult, GetObjectError>
  >
> {}

export const GetObject = Binding.Service<GetObject>("Nebius.storage.v1.Bucket.GetObject")

export const GetObjectHttp = Layer.effect(GetObject, Effect.gen(function* () {
  // deploy-time: hostIdentity(host) + bindHostEnv({ NEBIUS_S3_ENDPOINT,
  //   NEBIUS_ACCESS_KEY_ID, NEBIUS_SECRET_ACCESS_KEY, NEBIUS_BUCKET_NAME,
  //   NEBIUS_REGION }) + bucketPolicy group grant
  return Effect.fn(function* (bucket: NebiusBucket) {
    const BucketName = yield* bucket.name   // lazy Output, resolved at call time
    if (!globalThis.__ALCHEMY_RUNTIME__) { /* identity + grant + env */ }
    return Effect.fn("Nebius.storage.Bucket.GetObject")(function* (request) {
      // runtime: s3-lite-client from env; map errors via Schema.TaggedErrorClass
    })
  })
}))

export const GetObjectBinding = /* same, but env via { bindings: [secret_text...] } */
```

`PutObject` mirrors it. Runtime client is built once per binding from env values
(`s3-lite-client` `S3Client` with `{ endpointUrl, region, accessKeyId,
secretAccessKey }` — path-style for Nebius, verify in M0).

### `ai/v1/bindings.ts` — second capability

```ts
export interface ChatCompletions extends Binding.Service<
  ChatCompletions, "Nebius.ai.v1.Endpoint.ChatCompletions",
  (endpoint: NebiusEndpoint) => Effect.Effect<ChatClient>
> {}
```

Deploy-time: resolve base URL from `endpoint.publicEndpoints[0]` (Output), source
the auth token (open question O5), inject via `bindHostEnv` as
`NEBIUS_ENDPOINT_URL` / `NEBIUS_ENDPOINT_TOKEN` (secret). Runtime: `fetch`
`POST {base}/chat/completions` with a minimal `Schema.Class` response/error
surface. Only public endpoints supported (O6).

## Milestones

### M0 — Spike & verification (no code committed)

- [ ] Confirm `import * as Binding from 'alchemy/Binding'` resolves and
      `Binding.Service` / `Binding.Host` type-check from this package
- [ ] Confirm `bucket.name` / `endpoint.publicEndpoints` are accessible as lazy
      `Output`s inside a binding impl Layer (same as `bucket.bucketName` usage in
      AWS S3 bindings)
- [ ] Confirm `s3-lite-client` runs on `workerd` (fetch-based) and supports
      path-style addressing against `storage.<region>.nebius.cloud`
- [ ] Confirm AWS `binding.data.env` accepts lazy `Output` values (O2 fallback:
      resolve in the impl — values are available at deploy time)
- [ ] Prototype `bindHostEnv` with a fake host object; verify the two data shapes
      are what Lambda/Worker providers consume
- [ ] Verify `AccessKey` output secret survives a second deploy (state restore)
      — already implied by `precreate` + preserve-from-output, but prove it

### M1 — Host wiring core

- [ ] `modules/resources/shared/bind-host.ts`: `envToHostBindingData` (pure) +
      `bindHostEnv` (Effect.fn, `__ALCHEMY_RUNTIME__` guard, dies on unsupported
      host type)
- [ ] `modules/resources/shared/host-identity.ts`: lazy SA + AccessKey + Group +
      GroupMembership provisioning; returns `{ serviceAccountId, accessKeyId,
      secretAccessKey }` (Redacted)
- [ ] Unit tests `tests/resources/shared/bind-host.test.ts` (network-free):
      AWS shape, CF shape, Redacted→secret_text, unsupported host dies,
      runtime guard returns early
- [ ] `bun run check` clean, `bun test` green

### M2 — Storage bindings

- [ ] Resolve O4: exact role name + bucket-policy shape for object read/write;
      confirm whether `storage.viewer`/`storage.editor` are the right roles
- [ ] `modules/resources/storage/v1/bindings.ts`:
      `GetObject` + `PutObject` contracts; `*Http` and `*Binding` Layers each
- [ ] `Schema.TaggedErrorClass` errors: `BucketNotFound`, `ObjectNotFound`,
      `AccessDenied`, `InvalidCredentials` (env missing), `S3Error` (catch-all)
- [ ] Re-export from `storage/v1/index.ts`; wire into docs-namespace
- [ ] Unit tests (network-free): contracts defined, env mapping per host,
      error mapping from s3-lite errors
- [ ] `bun run check` clean, `bun test` green

### M3 — AI bindings

- [ ] Resolve O5: token sourcing (options below)
- [ ] `modules/resources/ai/v1/bindings.ts`: `ChatCompletions` contract +
      `*Http` / `*Binding` Layers; minimal chat-completions request/response
      `Schema.Class`
- [ ] `Schema.TaggedErrorClass` errors: `EndpointUnavailable`,
      `Unauthorized`, `ModelError` (provider-side failure)
- [ ] Re-export from `ai/v1/index.ts`
- [ ] Unit tests (network-free): contracts, env mapping, response decoding
- [ ] `bun run check` clean, `bun test` green

### M4 — Integration tests (SLOW_TESTS=1, real Nebius creds)

- [ ] `tests/resources/storage/v1/bindings.integration.test.ts`:
  - Deploy-time provisioning lifecycle: stack declares host identity
    resources; assert SA + AccessKey created, secret present in output
  - Runtime client: after deploy, call `GetObject` client against the real
    bucket (put + get round-trip via s3-lite-client)
- [ ] AI: deploy endpoint (if credentials permit), call `ChatCompletions`
      against `publicEndpoints[0]` with injected token
- [ ] Optional/stretch: full Cloudflare Worker end-to-end (`alchemy dev` +
      local Worker provider) — needs CF creds; mark skipped if unavailable
- [ ] Uses `integrationTest()` / `safeDestroy()` from `tests/helpers`

### M5 — Docs & examples

- [ ] `examples/bindings.ts`: one Cloudflare Worker stack + one AWS Lambda
      stack consuming the same `Nebius.storage.GetObject`
- [ ] README "Bindings" section: what they are, host support matrix (Lambda /
      ECS / EKS / Cloudflare Worker), one-line usage, env var reference
- [ ] Final: `bun run check` clean, `bun test` green, `SLOW_TESTS=1 bun test`
      passes with credentials

## Testing strategy

- **Unit (network-free, default `bun test`)**: pure `envToHostBindingData`
  mapping; contract tag identity; error mapping; response decoding. Uses
  existing `tests/helpers/provider.ts` style (`runEffect`, no cloud).
- **Integration (`SLOW_TESTS=1`)**: deploy-time provisioning + runtime client
  round-trip against real Nebius, gated by `tests/helpers/gate.ts`
  (`integrationTest`), cleaned up with `safeDestroy()`.
- Host-dependent paths (actual Lambda env injection, actual Worker
  `secret_text` upload) are exercised by alchemy's own provider tests upstream;
  we verify the *data shapes* in unit tests and, stretch, one CF Worker e2e.

## Open questions / risks

| # | Question | Impact | Resolution target |
|---|---|---|---|
| O1 | Do AWS `binding.data.env` values accept lazy `Output`s? | Env wiring ergonomics | M0 spike; fallback = resolve in impl |
| O2 | Does `s3-lite-client` work on workerd + path-style Nebius S3? | Storage runtime client | M0 spike |
| O3 | Is `isBindingHost`/`isWorker` duck-typing stable across alchemy versions? | D1 narrowing | Pin alchemy beta; keep local type list |
| O4 | Exact Nebius role names for bucket object ops (`storage.editor`?) and bucket-policy group-grant shape | Storage grant | M2, verify via Nebius docs/CLI |
| O5 | AI auth token sourcing: inline `authToken` prop isn't in attributes — read from props at deploy? binding-supplied token prop? mysterybox ref? | ChatCompletions design | M3 decision |
| O6 | Private-only endpoints unreachable from Lambda/Worker | AI binding scope | Document; public-only v1 |
| O7 | Bundle hygiene: ensure no `@grpc/grpc-js` / AWS SDK lands in runtime/binding bundles | Worker deploys | D4 + M2/M3 review of imports |
| O8 | One shared host identity vs per-capability keys | Least privilege | D3 decided: shared identity, per-capability grants |

## Out of scope (noted for later)

- KMS Encrypt/Decrypt, mysterybox GetSecretValue, DNS record bindings — same
  pattern once M2/M3 land
- Event sources / sinks
- `*Local` dev emulation layers
- Upstreaming `bindHostEnv` to `alchemy` as a shared env capability
