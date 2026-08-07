# Nebius AI Endpoint Bindings — Implementation Plan

Typed OpenAI-compatible runtime clients for Cloudflare Workers that call
user-deployed `Nebius.ai.Endpoint` inference containers (vLLM/TGI/Ollama-style
servers). One line at the call site yields the capability and derives, at
deploy time, the endpoint's public URL + auth token into Worker env bindings;
at runtime a fetch-based client calls `POST {url}/v1/chat/completions`.

```ts
export default Cloudflare.Worker("Api", { main: import.meta.url },
  Effect.gen(function* () {
    const endpoint = yield* Nebius.ai.Endpoint("llm", {
      image: "vllm/vllm-openai:latest",
      platform: "cpu-d3", preset: "4vcpu-16gb",
      /* subnet, ports, authToken, ... */
    })
    const chat = yield* Nebius.ai.ChatCompletions(endpoint)
    return { fetch: /* uses chat */ }
  }).pipe(Effect.provide(Nebius.ai.ChatCompletionsHttp)),
)
```

## Why this is simpler than storage bindings

Storage (`BINDINGS.md`) needed a full deploy-time identity — SA → group →
membership → v2 AccessKey, an `AccessPermit` grant, region config, and a
guarded dynamic import of gRPC (D8 bundle safety). **AI endpoints authenticate
with a bearer token, not IAM**, so:

- no host identity, no `AccessPermit`, no roles
- the public URL already carries region/host — no `NEBIUS_REGION` derivation
- deploy-time work = resolve **two** env values + `bindWorkerEnv`
- → the whole binding module is **statically workerd-safe**: no dynamic
  `import()`, no D8-style guard needed, zero gRPC in the Worker bundle by
  construction (still verified by a bundle check, see M4)

## Design decisions (locked in)

- **AD1 — Token plumbed through endpoint attributes (Option A).** Resource
  handles expose *attributes* only (`alchemy/src/Resource.ts:425` —
  `Output.PropExpr`); props are not reachable from a binding impl. The gRPC
  `Get` does not echo `authToken` (`EndpointStatus` has only
  `privateEndpoints`/`publicEndpoints`/`instances`/`state`). So: add
  `authToken: Schema.optional(Schema.String)` to `EndpointAttributesSchema` and
  return `{ ...toFriendlyAttributes(endpoint), authToken: news.authToken }`
  from reconcile — props persist in Alchemy state, so the value is available
  every deploy (same spirit as the AccessKey's preserved secret). No update RPC
  exists, so a token change in props already flows through the existing
  diff → `replace`. **Known limitation:** `read`/`list`/`ref` paths have no
  `news`, so adopted/imported endpoints carry no token → binding injects `''` →
  runtime 401. Fine for v1 (bindings target endpoints this stack deploys);
  documented.
- **AD2 — v1 surface: `ChatCompletions` only.** `Completions` / `Embeddings` /
  `Models` are noted in [§Later capabilities](#later-capabilities-noted-not-v1)
  — same contract/layer/env factory, thin additions.
- **AD3 — Typed SSE chunks for `stream: true`.** Discriminated result union
  (`{ stream: false; response } | { stream: true; chunks }`). Raw
  `ReadableStream<Uint8Array>` passthrough was rejected: it displaces the SSE
  parsing burden — and its bugs (frame splitting, CRLF, `[DONE]`, keepalives) —
  into every consumer. Parsing lives once, in the client.
- **AD4 — Mock-first testing.** The runtime client + SSE parser are tested
  against a local `Bun.serve` OpenAI-compatible mock (zero cloud, zero cost,
  seconds). The real-endpoint e2e — money + 5–30 min to provision — is gated
  behind `SLOW_TESTS=1` and deferred. See [Testing strategy](#testing-strategy).
- **AD5 — Errors are `Schema.TaggedErrorClass`.** Per AGENTS.md; stable tags,
  catchable by tag (see error union below).
- **AD6 — Env names namespaced.** `NEBIUS_ENDPOINT_URL` (plain_text),
  `NEBIUS_ENDPOINT_AUTH_TOKEN` (secret_text; empty string when auth disabled).
- **AD7 — Public endpoints only, fail fast at deploy time.** Workers cannot
  reach VPC-private URLs — bindings use `publicEndpoints[0]`. When the array is
  empty (endpoint STOPPED/PROVISIONING), the deploy fails with a clear tagged
  error via `Output.mapEffect` (the seam that can return an Effect at apply
  time). Endpoint must be RUNNING at deploy. Tradeoff noted in O1.
- **AD8 — No host identity, no grants, no dynamic import.** Bearer-token auth
  only. The binding module statically imports only workerd-safe code
  (contracts, `bind-host.ts`, schemas, fetch client).

## Architecture

### File layout

```
modules/resources/ai/v1/bindings.ts         # ChatCompletions contract + ChatCompletionsHttp layer + runtime client + errors
modules/resources/ai/v1/bindings.schema.ts  # OpenAI-compatible request/response/chunk schemas (Schema.Class)
modules/resources/ai/v1/endpoint.schema.ts  # ADD authToken attribute (AD1)
modules/resources/ai/v1/endpoint.ts         # provider returns authToken in reconcile attrs (AD1)
modules/resources/ai/v1/index.ts            # re-export binding namespace members
tests/resources/ai/v1/bindings.test.ts      # unit: env derivation, error mapping, SSE parser, schemas
tests/resources/ai/v1/bindings.integration.test.ts  # local-mock runtime (default) + impl runtime side
tests/helpers/openai-mock.ts                # Bun.serve OpenAI-compatible mock server (scripted SSE)
examples/ai.bindings.ts                     # Cloudflare Worker stack
examples/ai.bindings-worker.ts              # Worker entry (chat handler)
BINDINGS.md                                 # §Out of scope: point AI line at this doc
README.md                                   # Bindings section + AI endpoint binding entry
```

Exports (v1 — `*Http` = Cloudflare Worker layer; the AWS arm reserves
`*FunctionHttp` for later, same as storage):

```ts
Nebius.ai.ChatCompletions          // contract (callable)
Nebius.ai.ChatCompletionsHttp      // Cloudflare Worker Layer
// (later) Nebius.ai.ChatCompletionsFunctionHttp   // AWS-family Layer
// tag: "Nebius.ai.v1.Endpoint.ChatCompletions"
```

### Contract

Mirrors `Nebius.storage.v1.Bucket.GetObject` exactly:

```ts
export interface ChatCompletions extends Binding.Service<
  ChatCompletions,
  'Nebius.ai.v1.Endpoint.ChatCompletions',
  (endpoint: NebiusEndpoint) => Effect.Effect<
    (request: ChatCompletionsRequest) => Effect.Effect<ChatCompletionsResult, AiError>
  >
> {}

export const ChatCompletions = Binding.Service<ChatCompletions>('Nebius.ai.v1.Endpoint.ChatCompletions')
```

### Deploy-time env wiring

```ts
/** Pure-ish mapping — unit-testable with fake attrs. Outputs resolve at apply time. */
const endpointToEnv = (endpoint: NebiusEndpoint): Record<string, BindHost.EnvValue> => ({
  // Arrays stay plain Output (no indexed access on handles) — map to the first
  // public endpoint. Empty → tagged failure at apply time (AD7).
  NEBIUS_ENDPOINT_URL: Output.mapEffect((eps: readonly string[]) =>
    eps[0] ? Effect.succeed(eps[0])
           : Effect.fail(new EndpointNotRunning({ endpointId: ... })),
  )(endpoint.publicEndpoints),
  // Optional attr → normalize undefined to ''; Redacted → deployed as secret_text.
  NEBIUS_ENDPOINT_AUTH_TOKEN: Redacted.make(
    Output.map((t: string | undefined) => t ?? '')(endpoint.authToken),
  ),
})
```

`registerEnvOnce` (currently module-private in `storage/v1/bindings.ts`) is
**hoisted into `modules/resources/shared/bind-host.ts`** so both binding
families share the per-(host, name) dedupe — Cloudflare rejects duplicate
binding names on a single upload, and every capability injects the same
URL/token pair.

### Runtime client

- `readAiEnv(env)` — sibling of `readS3Env`: resolves the two env names,
  `InvalidCredentials` when missing.
- fetch-based, workerd-safe, memoized per binding (same pattern as the memoized
  `S3Client`).
- `POST {NEBIUS_ENDPOINT_URL}/v1/chat/completions` — path convention
  hardcoded (OpenAI-compatible servers serve at `/v1/...`); documented in O6.
- Headers: `Content-Type: application/json`; `Authorization: Bearer <token>`
  only when the token is non-empty (auth-disabled endpoints).

### Errors (AD5)

```
EndpointNotRunning     // deploy-time: publicEndpoints empty (AD7)
InvalidCredentials     // runtime: missing env bindings
EndpointUnauthorized   // 401
EndpointNotFound       // 404 (e.g. unknown model)
EndpointRateLimited    // 429
EndpointError          // 5xx / other status; carries error.type + error.code from the OpenAI error body
EndpointUnreachable    // fetch network failure
MalformedStream        // mid-stream: bad SSE framing or non-JSON event
```

Mapping reads the OpenAI error body `{ error: { message, type, code } }` where
present; falls back to status text.

### Streaming (AD3) — what `stream: true` implies

- Result union: `{ stream: false; response: ChatCompletion } | { stream: true; chunks: ReadableStream<ChatCompletionChunk> }`; consumer narrows on `stream`.
- **SSE parser** — a `TransformStream<Uint8Array, ChatCompletionChunk>`:
  - `TextDecoder` in streaming mode (workerd-safe, no Node `Buffer`)
  - frame split on `\n\n` / `\r\n\r\n`; extract `data:` lines; tolerate CRLF,
    keepalive `: comment` lines, `event:`/`id:`/`retry:` metadata (ignored in v1)
  - **JSON split across TCP chunks** — the classic bug: buffer until a complete
    frame before parsing
  - `data: [DONE]` terminates the stream
  - malformed JSON → `MalformedStream` (fail the stream, don't skip — a corrupt
    event means the endpoint is misbehaving)
- **Error split:** pre-stream HTTP errors (401/404/429/5xx) are ordinary fetch
  errors — status is known before the stream starts, mapped per the union
  above. Mid-stream, the only failures are framing/JSON (`MalformedStream`).
- Backpressure is free via `ReadableStream`; consumers do
  `for await (const chunk of stream)`.

## Milestones

Status: M1–M5 **done** (0 errors, full suite green). Bundle-safety spike ran
 (see M4); M6 pending (SLOW_TESTS).

- **M1 — Provider change (AD1). ✅** `authToken` in `EndpointAttributesSchema` +
  reconcile returns it from `news`. Unit + integration coverage.
- **M2 — Schemas + SSE parser. ✅** `bindings.schema.ts` (request, response,
  chunk — Schema.Class) + the `TransformStream` parser. Parser torture suite
  (split lines, CRLF, keepalives, `[DONE]`, malformed JSON).
- **M3 — Runtime client + errors. ✅** `readAiEnv`, fetch client, error mapping,
  the full tagged error union. Local-mock integration tests (Bun.serve
  OpenAI-compatible mock, zero cloud).
- **M4 — Contract + layer. ✅** `ChatCompletions` + `ChatCompletionsHttp`;
  `registerEnvOnce` hoisted into `shared/bind-host.ts` (storage refactor,
  storage tests green); impl runtime-side test with `__ALCHEMY_RUNTIME__`
  pre-set `true` + mocked host.

  **Bundle-safety spike (`spikes/ai-bindings-bundle.ts`)** — built the
  binding module + both example worker entries through alchemy's real
  `Bundle.build` (fold on/off):
  - ✅ The AI binding module itself has **no gRPC and no dynamic import**
    (no `@grpc`/`grpc-js` markers; the `nebius.ai.v1` string in the bundle is
    just the contract tag). AD8's core claim holds.
  - ⚠️ **~1 MB of Node-platform machinery** (`ws`, Effect `Socket`,
    `node:net`/`http2`/`tls`/`os`) enters every binding bundle via
    `alchemy/Output`'s transitive graph (`Output → Stack → Cli` — the CLI
    imports the Node platform). Affects storage bindings **identically**;
    an alchemy-internal structural issue (beta.70 vs the beta.67 the M0
    spike measured) — worth reporting upstream.
  - ⚠️ Full worker entries (AI **and** storage) additionally carry gRPC from
    the statically-imported resource modules (endpoint/bucket) used in the
    impl gen — the pre-existing storage example pattern.
  - The M0 "67 KB / zero gRPC" result is **not reproducible** against the
    current alchemy; whether workerd tolerates the dead Node builtin imports
    (nodejs_compat stubs; never executed at runtime) is the real
    deployability question — that is what M6's real deploy verifies.
- **M5 — Exports, examples, docs. ✅** Re-exports through `ai/v1/index.ts`;
  `examples/ai.bindings.ts` + `ai.bindings-worker.ts`; `BINDINGS.md`
  §Out of scope and `README.md` updated.
- **M6 — (pending, SLOW_TESTS=1) Real-endpoint e2e.** Deploy a cheap CPU
  endpoint (smallest preset + tiny OpenAI-compatible image), full deploy-time
  wiring (real `publicEndpoints` attrs) + real chat round-trip through the
  binding. Money + 5–30 min, gated behind `integrationTest`/`safeDestroy` like
  the storage M3 tests. Also verifies the AD7 apply-time failure surfaces as a
  clean deploy error.

## Testing strategy

1. **Unit (default `bun test`, network-free):** `endpointToEnv` (URL from
   `publicEndpoints[0]`; token present → secret_text; absent → `''`; empty
   array → `EndpointNotRunning`), `readAiEnv` (missing → `InvalidCredentials`),
   error mapping (OpenAI error-body shapes → tags), schema round-trips, SSE
   parser torture suite.
2. **Runtime client vs local mock (default `bun test`):** `Bun.serve`
   OpenAI-compatible server with scripted responses/frames — full request
   shape, Bearer header, error statuses, streaming.
3. **Impl runtime side (default `bun test`):** `__ALCHEMY_RUNTIME__` pre-set
   `true` + `WorkerEnvironment` layer → exercises the real client path inside
   the layer without the deploy-time branch.
4. **Deploy-time wiring e2e (SLOW_TESTS, deferred):** unlike a bucket (whose
   attrs exist post-create), `publicEndpoints` only exist once the endpoint is
   **RUNNING** — the full impl test genuinely needs a real endpoint. That is
   M6.

## Open questions / risks

| # | Question | Decision | Status |
|---|----------|----------|--------|
| O1 | Fail-fast on a stopped endpoint at deploy time (AD7) vs lenient empty-URL + runtime error? | Fail-fast; endpoint must be RUNNING. A stopped-at-deploy endpoint yields a useless env anyway | locked |
| O2 | Mid-stream malformed JSON: fail stream vs skip event? | Fail with `MalformedStream` (corrupt event = misbehaving endpoint) | locked |
| O3 | Long-stream timeout handling? | No built-in timeout; document `ctx.waitUntil` + endpoint idle behavior | open |
| O4 | Adopted/ref'd endpoints lose the token (read/list lack `news`) → runtime 401 | Documented limitation; v1 targets stack-deployed endpoints | open |
| O5 | Multi-port, auth-disabled endpoints: which URL? | First public endpoint; port selection later | open |
| O6 | `/v1/chat/completions` path hardcoded — container must serve an OpenAI-compatible API | Documented; path config later if needed | open |

## Later capabilities (noted, not v1)

- `Completions` / `Embeddings` / `Models` — same factory; `Models` doubles as a
  cheap liveness check
- `wireAsyncBindings` sibling for async (non-Effect) Workers
  (`examples/storage-async.bindings.ts` pattern)
- MysteryBox-sourced token (Option C): read the secret payload at deploy time
  in the CLI — real plumbing, skipped for v1
- Port selection for multi-port endpoints (O5)
- AWS host arm: `ChatCompletionsFunctionHttp` (`{ env }` merge, §AWS in
  BINDINGS.md)

## Out of scope

- Nebius AI Studio's hosted OpenAI-compatible API (`api.ai.nebius.cloud`,
  API-key auth) — a different product surface, no `ai.v1.Endpoint` resource;
  would be a separate binding (an API-key env injection, no deploy-time URL
  derivation)
- gRPC at runtime (endpoint control plane) — deploy-time only, via the
  existing `api-client`
- Event sources / sinks, `*Local` dev emulation
