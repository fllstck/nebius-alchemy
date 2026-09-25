# ISSUES

> Findings from the 2026-09-25 pre-production roast, turned into fixable tasks. Each entry is
> self-contained: **evidence** (verified line numbers), **why it bites**, **fix**, and
> **acceptance** — the test or measurement that proves the fix, so nothing here is closed by
> assertion.
>
> Unlike `TASKS.md`, this file is **not** gitignored. If it should stay local-only, add
> `ISSUES.md` to `.gitignore` before the next commit.
>
> `AGENTS.md` remains the authority on **invariants**. Where a fix here would change an
> invariant, the task says so and names the section to update in the same commit.

**Status legend**: `OPEN` · `IN PROGRESS` · `BLOCKED` (reason) · `DONE (date, commit)`
**Effort**: `S` ≤ half a day · `M` ≤ 2 days · `L` > 2 days
**Risk**: what breaks if the fix is wrong — `LOW` (offline) · `MED` (deploy-time) · `HIGH` (live
infra / credentials)

| ID | Severity | Area | Title | Effort | Risk |
|----|----------|------|-------|--------|------|
| R-01 | CAREER ENDER | api-client | Retry idempotency key is per-attempt, so retried mutations can double-apply | M | HIGH |
| R-02 | CAREER ENDER | compute/hosted | Destroy silently leaks a live S3 fetch AccessKey when the key list fails | S | MED |
| R-03 | EMBARRASSING | api-client | `maxBackoff` is documented, exported, and never implemented | S | LOW |
| R-04 | EMBARRASSING | tools/lint | Custom lint rules have no self-test, which is why R-05/R-06 survived | M | LOW |
| R-05 | EMBARRASSING | tools/lint | `no-effect-ignore` (severity `error`) cannot see `pipe(Effect.ignore)` | S | LOW |
| R-06 | EMBARRASSING | tools/lint | `no-silent-error-swallow` bans a pattern nobody writes; 31 real swallows pass | M | LOW |
| R-07 | EMBARRASSING | mk8s | `Effect.fail(new Error(…))` — plain `Error` in a typed failure channel | S | LOW |
| R-08 | EYE ROLL | compute/v1 | `Instance.reconcile` is a 341-line god function | L | MED |
| R-09 | EYE ROLL | capacity/mk8s | User-config errors raised as `Effect.die` defects, inconsistently | S | LOW |
| R-10 | EYE ROLL | api-client | 91 `as unknown as` casts leave every service boundary unchecked | M | LOW |
| R-11 | EYE ROLL | api-client | `paginateAll` loops forever on a repeated `nextPageToken` | S | LOW |
| R-12 | EYE ROLL | resources/factory | Tenant fan-out: no project-list memoization, no concurrency | M | LOW |
| R-13 | EYE ROLL | tests | A unit test really sleeps ~1 s to cover a backoff default | S | LOW |
| R-14 | EYE ROLL | auth | Loopback callback URL built from the untrusted `Host` header | S | LOW |
| R-15 | MEH | tools/schema-conformance | Branded-ID audit is informational; its count drifts (`13` vs 16 lines) | M | LOW |
| R-16 | MEH | dns/v1 | `ZoneNotEmpty.zoneId` is an unbranded id while `ZoneId` exists | S | LOW |
| R-17 | MEH | modules/** | 41 copies of `eslint-disable-next-line require-yield` should be one config entry | S | LOW |
| R-18 | MEH | tests | The maintainer's real project id is committed in 9 places | S | LOW |
| R-19 | MEH | compute/hosted | `quoteEnvValue` turns a newline into literal `\n`; no round-trip test | S | MED |
| R-20 | MEH | compute, ai | Create-failure recovery does not classify the failure first | S | LOW |
| R-21 | EMBARRASSING | iam/v1 | Static keys are project-parented, but `list` queries per service account — nuke cannot see them | S | MED |

---

## CAREER ENDERS

### R-01 — Retry idempotency key is per-attempt, so retried mutations can double-apply · `DONE (2026-09-25)`

**Files**: `modules/api-client/grpc-utils.ts` (`isRetryableReadMethod`, `wrapGrpcClient`) ·
`modules/api-client/GrpcTransport.ts:86-92` · `modules/auth/sa-bootstrap.ts:91` · probe
`spikes/idempotency-key-probe.ts`

**Evidence (the original)**: every service built by `makeGrpcService` got `withGrpcRetry(…,
{ maxRetries: 3 })` applied to **all** unary methods (`:602` → `:200`), and the retry set was
`[4, 8, 10, 13, 14, 15]` (`:54`). The `x-idempotency-key` that was meant to make that safe was
minted **inside the metadata generator** (`GrpcTransport.ts:91`), and grpc-js runs that generator
once per RPC attempt while `withGrpcRetry` re-invokes the whole wrapped call — so a retry carried a
different key. The comment at `GrpcTransport.ts:86-89` claimed the opposite.

**Decision — branch 2, and the probe is what forced it.** Branch 1 (mint per logical operation) only
buys anything if the server dedupes on the key. The probe measured that on `iam/v1 StaticKey.Issue`,
with `randomUUID()`-shaped keys (the format the gosdk mints, in case the server validates the shape):

| arm | request | result |
| A | `issue(key=K, name=N)` | accepted → `statickey-e00rgp93kahkm10hs2` |
| B | `issue(key=K, name=N)` — same key, same request, **after A completed** | `6 ALREADY_EXISTS` |
| C | `issue(key=K2, name=N)` — different key, same name | `6 ALREADY_EXISTS` |
| D | `issue(key=K3, name=M)` — reference, left unpolled | accepted |
| E | `issue(key=K3, name=M)` — same key, sent immediately (in flight) | `6 ALREADY_EXISTS` |

So the API does **not** dedupe on `x-idempotency-key` — not for a completed operation (B) and not for
an in-flight one (E). The key is audit/convention only (the gosdk also mints a fresh one per request).
Branch 1 therefore buys nothing, and a retried mutation is simply a **second request**. Two of this
entry's own claims were wrong too, and the measurement corrects them:

- **`StaticKey` names ARE unique per project.** The entry said "no name uniqueness ⟹ two live
  credentials"; B *and* C answered `ALREADY_EXISTS`. The damage is subtler and worse for a credential:
  the key **exists** with a token the client never received and can never recover — a live credential
  nothing tracks.
- **The `list` parent is the project, not the service account** (`byProjectParent: 2`, `bySaParent: 0`)
  — filed separately as **R-21**.

**Fix (branch 2)**: retries now apply to **reads only**. `isRetryableReadMethod` classifies each
descriptor method against a read-verb allowlist (`get`/`list`/`find`/`search`/`batchGet`/`estimate`/
`preflight`/`describe`); every mutation verb **and every unknown verb** is capped at `maxRetries: 0`.
The default is deliberately unsafe-to-retry rather than unsafe-to-lose: a read that loses a retry is a
small resilience loss, a mutation that gains one is a duplicate write. One read is denied as well —
`getSecretOnce`, whose secret is handed out once, so a retry after a lost response could never be
recovered. The false `GrpcTransport.ts` comment is replaced with the measurement; `sa-bootstrap.ts`
keeps its per-call key with a comment saying why that is correct there (no retry on that path).

**Acceptance — met**:
- `tests/api-client/grpc-utils.test.ts` → `isRetryableReadMethod` classifies the **whole generated
  method inventory**: every read verb in `schemas/nebius` as retryable, every mutation verb plus an
  unknown verb and `getSecretOnce` as not.
- `tests/api-client/grpc-utils.test.ts` → a mutation is attempted exactly once on code 13, and exactly
  once after a client-side timeout (code 4); a read still retries (3 attempts for a `get` that fails
twice on code 14).
- Live probe above; `spikes/idempotency-key-probe.ts` is the re-runnable evidence.

**Residual (explicitly out of scope)**: branch 2 does not remove the *orphan* — a create that times out
client-side but succeeded server-side still leaves a resource with no state row, and now fails with
`DEADLINE_EXCEEDED` rather than `ALREADY_EXISTS`. Adopting it needs get-by-name recovery in `reconcile`,
which only 2 of 40 providers have (`compute/v1 instance`, `ai/v1 endpoint`); R-20 is the adjacent item
(classify the failure before attempting that recovery).

---

### R-02 — Destroy silently leaks a live S3 fetch AccessKey when the key list fails · `DONE (2026-09-25)`

**Fixed**: `cleanupHostedRuntime` (`modules/resources/compute/v1/hosted.ts:1251-1281`) recognises
`NOT_FOUND` (5) as the only benign code on **both** the list and the delete, and reports every other
outcome as an `Effect.logWarning` naming the key (and, on delete, its id) and the error.

**Warn-and-continue, not fail-hard, on purpose** — a failed delete makes the planner skip every
dependent and leaks the *parents* (AGENTS.md §"Resource provider patterns"), while the cause — a key
the caller can neither list nor delete — is persistent, so a re-run fails identically. The leak cannot
be repaired from here; making it visible can. The delete branch carried the second half of the same
defect: its blanket catch labelled *every* failure "already gone", so a `PERMISSION_DENIED` was
reported as a successful cleanup.

**File**: `modules/resources/compute/v1/hosted.ts:1224`

**Evidence**:
```ts
const keys = yield* iamGrpcService.accessKeyV2.list(parentId).pipe(Effect.catch(() => Effect.succeed([])))
const key = keys.find((candidate) => candidate.metadata?.name === hostedRuntimeKeyName(id))
if (key?.metadata?.id) { /* delete */ }
```
The sibling branch 11 lines above (`:1206-1209`) logs loudly on failure, with a comment explaining
that "a silent leak (BucketNotEmpty on the bucket delete) is worse than a noisy destroy".

**Why it bites**: `PERMISSION_DENIED`, `UNAVAILABLE`, or an expired/rotated key turn into "no keys
found", the delete is skipped, and a still-valid credential granting read access to the hosted
bundle bucket survives `alchemy destroy --yes` with no log line.

**Fix**: replace the blanket catch with an explicit one — match `code === 5` (already gone) as
success, otherwise `Effect.logWarning` naming the expected key name and the error and **do not
pretend the list succeeded**. Re-raise if the delete path cannot continue safely.

**Acceptance**:
- Test: a mocked list failing with `PERMISSION_DENIED` produces a warning that names
  `hostedRuntimeKeyName(id)` and the error, and does not resolve to a silent success.
- Test: a list answering `[]` (genuinely no key) stays silent — no false alarm.

**Met** — 6 offline tests in `tests/resources/compute/v1/hosted.test.ts` (`describe('hosted
cleanupHostedRuntime — the fetch key is never lost silently')`): denied list, `[]` list, `NOT_FOUND`
list, the happy path, denied delete, `NOT_FOUND` delete. Mocked `IamGrpcService` with `output`
undefined, so no S3 client is constructed and nothing touches the network.

**Negative control (run, not asserted)**: with the old body restored, exactly the two leak assertions
fail — the denied list reports `deleted === []` (no delete attempted, i.e. the leak) and the denied
delete names neither the key nor its id. The other four are invariants the old code happened to hold.

**Rider (same defect, the verifier itself)**: `tests/resources/compute/v1/hosted-instance.integration.test.ts`
`verifyAssetsCleanup` swallowed its own list failures, so a `PERMISSION_DENIED` there reported "no leak" —
a green verifier for exactly this leak. Both lists now treat `NOT_FOUND` as success and propagate
everything else (`safeDestroy` fails the test on a failing verify). It is the live witness for this fix,
so it had to be able to fail.

---

## EMBARRASSING MOMENTS

### R-03 — `maxBackoff` is documented, exported, and never implemented · `DONE (2026-09-25)`

**File**: `modules/api-client/grpc-utils.ts:56-63,75-100` (public: `modules/api-client/index.ts:2`)

**Evidence**: `maxBackoff` is declared at `:63` with a `30_000` default in its doc comment;
`grep -rn maxBackoff modules/ tests/` returns **one** hit — the declaration. The loop at `:79-100`
computes `initial * 2 ** attempt` with no cap. `pollOperation` (`:407`) *does* cap at 30 s, so the
pattern is known and was forgotten in the twin.

**Why it bites**: a published option that lies. Anyone setting `maxBackoff` believes they bounded
the backoff. No test covers it, because every existing retry test passes `initialBackoff: 0` and
therefore cannot observe a backoff curve.

**Fix**: `const delay = Math.min(initial * 2 ** attempt, maxBackoff ?? 30_000)` and a doc line
saying the cap applies to the pre-jitter delay.

**Acceptance**:
- Test (via `Effect`'s `TestClock`, not a real sleep): the scheduled delay for a large attempt is
  the cap, not `initial * 2 ** attempt`.
- Test: with no `maxBackoff`, the cap is 30 s.

**Fixed**: `const delay = Math.min(initial * Math.pow(2, attempt), maxBackoff)` with
`maxBackoff = options?.maxBackoff ?? 30_000`, and the option's doc comment now says the cap applies to
the **pre-jitter** delay (jitter scales the capped value to 50–100 %), which is why the assertions are
windows rather than equalities.

**Met** — both acceptance tests run on `TestClock`: with `initialBackoff: 120_000` (uncapped 120 s and
240 s, jittered 60–240 s) the observed gaps are 2_500–5_000 ms for an explicit `maxBackoff: 5_000` and
15_000–30_000 ms with the option omitted. The explicit case is what catches a *hardcoded* cap: a
constant 30 s would fail the 5 s window.

**Negative control (run)**: reverting the `Math.min` fails both tests — the gaps come back as
60–240 s windows — so the assertions are wired to the fix, not to the absence of one.

---

### R-04 — Custom lint rules have no self-test · `DONE (2026-09-25)`

**Deviation from the fix as written** — no `__fixtures__/` directory and no `bun test tools/`. There is
already a purpose-built harness for exactly this job: `tests/tools/oxlint-plugin.test.ts` drives the real
`oxlint` binary over a temp fixture + temp config, asserts on structured JSON, and locates the binary by
walking up (`node_modules/.bin` is not copied into Stryker's mutation sandbox). It covered only
`no-alchemy-deepequal`. A second mechanism beside it is the layering this repo retires rather than adds,
and the on-disk shape costs config changes purely to keep deliberate violations out of the build: a
config inside `__fixtures__/` **shadows the root config for its subtree** (oxlint resolves the *nearest*
config per file — measured), so the root's `ignorePatterns` never skips the fixtures, and the snippets
would need a `tsconfig.json` exclusion since `Effect.catchAllCause` cannot compile.

**What shipped**: the existing harness now takes the rule as a parameter and carries `CASES` — one
must-trip and one must-pass snippet for each of the four remaining rules — plus two mechanical
completeness checks: every rule the plugin declares must be covered (the plugin is imported, so that list
is not hand-maintained), and the declared list is itself pinned so a new rule prompts its cases.
`check` now runs `bun run test:rules` (`bun test tests/tools/`), which is the acceptance criterion made
literal.

**Acceptance**: measured in both directions. (1) **Rule inert** (the `pipe(Effect.ignore)` hole): the
must-trip case fails and `bun run check` exits 1 — the negative control for R-05 *is* this criterion, and
it was run. (2) **Rule over-broad** (the `log` allowance removed): the must-pass case fails. With both
directions restored, `check` exits 0.

**File**: `tools/oxlint-nebius-plugin/index.js` (all five rules)

**Evidence**: R-05 and R-06 are both cases of a rule matching the wrong AST shape; neither was
caught, because the plugin has no fixtures and no negative control. There is no test file under
`tools/`.

**Why it bites**: a rule that has never been observed *failing* is a comment with a schema. Every
future rule inherits the same blind spot, and "the lint is green" reads as evidence when it is not.

**Fix**: add `tools/oxlint-nebius-plugin/__fixtures__/` pairing each rule with one must-fail and one
must-pass snippet, plus a runner (`bun test tools/`) that lints them and asserts the reports. Wire
it into `bun run check`. **Land this before or with R-05/R-06** so the fix is itself proven.

**Acceptance**: `bun run check` fails if a rule stops matching its must-fail fixture.

**Met** — `check` runs the rule tests, and breaking a rule's match (verified: renaming the property the
`no-effect-ignore` visitor matches) turns `bun run check` into exit 1 within the same command.

---

### R-05 — `no-effect-ignore` (severity `error`) cannot see `pipe(Effect.ignore)` · `DONE (2026-09-25)`

**File**: `tools/oxlint-nebius-plugin/index.js:57-82` vs `modules/resources/compute/v1/hosted.ts:1213`

**Evidence**: the rule matches only a `CallExpression` whose property is `ignore` (`:73`). The one
occurrence in the repo is the reference form:
```ts
Effect.tapError(...),
Effect.ignore,     // ← passed as an argument, never "called"
```
```
$ bunx oxlint modules/resources/compute/v1/hosted.ts   # rule is "error" in .oxlintrc.json
$ echo $?
0
```

**Why it bites**: the guardrail is inert against the idiomatic shape, and that shape is the only one
present. `Effect.ignore` discards the entire failure channel of the S3 cleanup.

**Fix**: detect `Effect.ignore` as an identifier wherever it appears (argument position included),
or ban the import member outright so both forms are covered. Then decide what to do with
`hosted.ts:1213` — log-and-continue explicitly rather than ignore.

**Acceptance**: R-04's must-fail fixture for this rule includes the `pipe(Effect.ignore)` form.

**Met** — `CASES['no-effect-ignore']` carries both forms as must-trip cases.

**Fixed**: the rule matches a `MemberExpression` instead of a `CallExpression`, so the reference form is
covered, and it distinguishes *audible* from *silent*: `Effect.ignore` is not inherently silent in v4 — it
takes an options object and `log` emits the full `Cause`, defects included. Banning the member outright
would have pushed the one legitimate use behind an `oxlint-disable` with a comment, so
`Effect.ignore({ log, message })` is allowed and the report message names it. `hosted.ts`'s occurrence now
uses that form, replacing `tapError` + bare `ignore`: the `tapError` only ever saw *typed* failures, so a
**defect in the cleanup was discarded with no log line at all** — a second, quieter hole in the same line.

**Two findings while fixing it**, recorded rather than left in a session log:

- **`nebius/no-effect-catchallcause` bans an API that does not exist.** `grep -rl catchAllCause
  node_modules/effect/dist` is empty for the pinned `4.0.0-rc.117`; v4 spells the capability
  `catchCause`, which is deliberately NOT banned (best-effort cleanup — a destroy path must not fail on a
  defect — is its legitimate use). So the rule can only ever fire on code that would not compile. It is
  kept for now as a guard against the v3 name returning, with the measurement in its comment and a
  must-fail fixture that proves the rule *fires* rather than that it protects. Next session would either
  re-target it or retire it (the repo retires mechanisms rather than layering them).
- **The fixed rule adds two `warn`-level hits in `tests/**`** (where `.oxlintrc.json` deliberately
downgrades it): `tests/api-client/storage/BucketGrpcService.test.ts:284` and
  `tests/helpers/cleanup.ts:118`. The latter **must not** be "fixed": it logs `redact(String(e))` and then
  ignores, and `ignore({ log })` would emit the *unredacted* cause — the one site where the warn is a true
  false positive. Escalating the rule to `error` for `tests/**` would therefore need that site exempted
  with a reason first.

---

### R-06 — `no-silent-error-swallow` bans a pattern nobody writes · `DONE (2026-09-25)`

**File**: `tools/oxlint-nebius-plugin/index.js:94-190` (`isEffectVoidBody` at `:120`)

**Evidence**: the rule fires only when the handler's body is `Effect.void`. The repo's actual
swallow is `() => Effect.succeed([])` / `succeed(undefined)`:
```
$ grep -rn "Effect.catch(() => Effect.succeed" modules/ | wc -l   → 31
$ grep -rn "() => Effect.void"                  modules/ | wc -l   → 0
```
17 files, worst offenders `vpc/v1/actions.ts` (5), `iam/v1/group-membership.ts` (3).
The rule is also configured `"warn"`, so even a hit would not fail CI.

**Why it bites**: a `read`/`list` that swallows `PERMISSION_DENIED` and answers `[]` reports "this
resource does not exist" to drift detection and to `alchemy unsafe nuke`. R-02 is one concrete
instance of this class.

**Fix**: extend the handler check to constant-literal bodies (`Effect.succeed([])`,
`Effect.succeed(undefined)`, `Effect.succeed(null)`), and raise the rule to `error` for
`modules/**`. Then classify the 31 sites: each becomes either a tagged-error raise, a
`catchTag('GrpcError', …)` narrowed to `code === 5`, or an `oxlint-disable` **with a reason** —
which at least makes the swallow visible.

**Acceptance**:
- R-04 fixture: `() => Effect.succeed([])` fails, `() => Effect.succeed(undefined)` fails,
  `(e) => Effect.logWarning(…)` passes.
- Every remaining site in `modules/**` carries an inline disable with a reason, or is gone.

**Met** — `CASES['no-silent-error-swallow']` has six must-trip cases (`Effect.void`, `succeed([])`,
`succeed(undefined)`, `succeed(null)`, `succeed([] as readonly string[])` — assertions are unwrapped —
and a block-bodied `{ return Effect.succeed([]) }`) and four must-pass cases (logging handler, narrowed
to `code === 5`, log-then-empty, and `succeed(0)` as a non-empty constant). `bun run lint` reports **0**
sites. The rule also went from `warn` to `error`, and `.oxlintrc.json`'s exemption for
`modules/state/ensure-bucket.ts` was deleted — **that file does not exist** (there is no `modules/state/`
at all), so the config's only documented escape hatch was a phantom.

**The rule**: handlers are now matched structurally for a *constant* body — `Effect.void` or
`Effect.succeed([] | undefined | null)` — with type-only wrappers (`as`, `satisfies`, `!`, parens) stripped,
since `Effect.succeed([] as readonly X[])` is the spelling the repo actually uses. Same defect from both
sides: `Effect.void` discards the failure, `Effect.succeed([])` tells the caller the resource does not
exist.

**The sweep — 32 sites, not 31.** The roast's grep counted `catch(() => Effect.succeed(…))`; the rule
also caught `storage/v1/transfer.ts:235` (`catchTag(…)`), which is the same defect through a different
combinator. Four treatments, because the sites are not one situation:

1. **Tenant fan-out (24 sites)** — `factory.ts`'s `makeTenantScopedList` (every provider's `list`) plus 9
   hand-written nested fan-outs (`dns Record`, `iam AccessPermit`/`GroupMembership`/`StaticKey`/
   `FederationCertificate`, `vpc Route`/`SecurityRule`, `mysterybox SecretVersion`, `mk8s NodeGroup`), 5
   `vpc` actions, and one each in `iam`/`quotas`. All now go through the new
   `modules/resources/shared/fan-out.ts`: `NOT_FOUND` is quiet (the parent was deleted between the project
   list and this call), anything else answers `[]` **plus a warning naming the parent and the error and
   saying the result is PARTIAL**, and a *defect* propagates (a bug in an enumeration is not a missing
   parent). Not a hard failure: this fan-out is `alchemy unsafe nuke`'s enumeration — its only caller — and
   aborting over one inaccessible project leaves strictly more behind. But a partial list must never read as
   a complete one, which is what `Effect.catch(() => Effect.succeed([]))` did. 6 unit tests in
   `tests/resources/shared/fan-out.test.ts`, including that a defect is not swallowed.
2. **Adopt-by-identity lookups (2 sites)** — `iam/v1 AccessPermit:67`, `GroupMembership:77`. Narrowed to
   `code === 5`. These are *create-path* decisions: an unverified lookup answering `[]` is indistinguishable
   from "no such permit exists", and the branch below would create a **duplicate**. There is no partial
   result to preserve here, which is why this class does not use the fan-out's treatment.
3. **Create-failure recovery lookups (3 sites)** — `ai/v1 {Endpoint,Job}`, `compute/v1 Instance`. Warn, then
   fall through to the *original* create error. `NOT_FOUND` is the case the recovery exists for; any other
   failure means the lookup could not answer, and re-raising it would replace the informative create failure
   with a misleading lookup failure. (Which codes should reach that recovery at all is R-20.)
4. **Destroy pre-step (1 site)** — `storage/v1/transfer.ts:235` (`stop` before `delete`). Now
   `Effect.ignore({ log: 'Warn', message })`: the delete below is authoritative, and a destroy must not be
   blocked by a pre-step (a failed delete makes the planner skip every dependent and leaks the parents).

**Gates**: `bun run check` exit 0 · `bun test` **1707 tests / 1632 pass / 75 skip / 0 fail** ·
`bun run typecheck` clean. No existing test pinned the old swallow behaviour — verified by running the whole
suite before and after the sweep, not assumed.

**Findings recorded while sweeping** (not fixed here, none of them blocking):

- **`modules/resources/actions/shared.ts`'s `listProjectIds` is dead** — zero references in `modules/`,
  `tests/` or `examples/`; the three action files inline the same `parentId ? [parentId] : (yield*
  iam.project.list(tenantId)).map(…)` expression instead. Either use it in those three places or delete it.
- **The rule does not cover `catchIf` / `orElseSucceed` / `catchCause` handlers** — only `catch`/`catchTag`.
  There are zero such sites today (`grep` over `modules/`), so this is a coverage gap rather than a live hole;
  it belongs with the next rule change, with fixtures.
- **`Nebius.iam.actions.ListProjects` and its siblings now propagate a non-NOT_FOUND tenant-level failure**
  rather than reporting "this tenant has no projects" (`iam/actions.ts:45`) — the one site in the sweep that
  is neither a fan-out nor a lookup, because swallowing there hides *everything* rather than one parent.

---

### R-07 — `Effect.fail(new Error(…))`: plain `Error` in a typed failure channel · `DONE (2026-09-25)`

**File**: `modules/resources/mk8s/v1/kubernetes-adapter.ts:159`

**Evidence**: 12 lines above, the same generator raises a proper tagged error:
```ts
return yield* Effect.fail(new ClusterNotFoundError({ … }))                    // :146-149  ✅
…
return yield* Effect.fail(
  new Error(`mk8s cluster '${auth.clusterId}' has no endpoint or certificate authority yet …`),
)                                                                            // :157-161  ❌
```

**Why it bites**: straight violation of the Critical Rule ("MUST use `Schema.TaggedError` for all
custom errors"). It is uncatchable by tag, so no caller can distinguish "cluster still creating"
(retryable) from "cluster is gone" (fatal) — the exact distinction that matters here.

**Fix**: `ClusterNotReadyError` as a `Schema.TaggedError` (or fold into `ClusterNotFoundError` with
a discriminating field) and add it to the adapter's declared error channel.

**Acceptance**: `Effect.catchTag('ClusterNotReadyError', …)` compiles and is exercised by a test;
`grep -n "new Error(" modules/resources/mk8s/v1/kubernetes-adapter.ts` shows only the
`Effect.die` case at `:93` (defect by design — document why).

**Met** — `ClusterNotReadyError` is a `Schema.TaggedError` in `mk8s/v1/cluster.schema.ts` with a
**branded** `clusterId` (`Ids.ClusterId`, which the R-15 audit would have demanded anyway), raised by the
new `requireClusterTransport` helper, and covered by two tests: the error shape
(`_tag` + `clusterId`) and `Effect.catchTag('ClusterNotReadyError', …)` recovering. The file's only
remaining `new Error(` is the `die` at `:93`, now with a doc comment saying why (a closed auth union plus
an adapter that only ever receives connections it built ⟹ a programmer error, not a runtime outcome).

**One measured limit, recorded rather than papered over**: alchemy's `ClusterAdapterService.connect`
declares its error as `ClusterNotFoundError | Error`, and `Error` carries no `_tag`, so at *that*
boundary `Effect.catchTag('ClusterNotReadyError')` does not typecheck — the tag discriminates in our own
channel (`requireClusterTransport`, which is what `connect` calls) and at runtime, but not through the
framework interface. That is why the tagged channel was extracted into a helper instead of left inline:
the acceptance asks for a test that exercises the capability, and this is the only place it is
statically reachable.

---

## EYE ROLL COLLECTION

### R-08 — `Instance.reconcile` is a 341-line god function · `OPEN`

**File**: `modules/resources/compute/v1/instance.ts:511-852`

**Evidence**: one generator performs hosted-runtime resolution, create (+ get-by-name recovery),
update, stop, restart-on-hash-divergence, start, wait-for-state polling, and drift evaluation. The
repo's own doctrine (`AGENTS.md` §Resource provider patterns, last paragraph) says to extract a
testable seam "when the reconcile body is too heavy to test through" — the drift list was extracted
(`instanceSpecDrifted`), the lifecycle phases were not.

**Why it bites**: every future behavioural change lands here and is only testable end-to-end
through the front door. It is also the file consumers read when learning the provider.

**Fix**: extract exported `Effect.fn` phases — `ensureCreated`, `applyUpdate`, `ensureRunning`
(stop/restart/start), `awaitInstanceState` — leaving `reconcile` as ~60 lines of sequencing. Keep
`instanceSpecDrifted` where it is.

**Acceptance**:
- `reconcile` under ~100 lines; each phase has unit tests using `tests/helpers/mocks.ts`.
- All existing `tests/convergence.test.ts` rows for `compute/v1 Instance` still green, unchanged —
  the refactor must not move a single plan decision. If a row needs editing, that is a behaviour
  change and needs its own justification.
- `bun run check` and `bun test` clean.

---

### R-09 — User-config errors raised as `Effect.die` defects, inconsistently · `DONE (2026-09-25)`

**Files**: `modules/resources/capacity/v1/actions.ts:251-258` vs `modules/resources/shared/tenant.ts:50-57`

**Evidence**: the missing-project-id case dies:
```ts
return yield* Effect.die(
  new Error('Nebius project ID is required to list capacity allowances but NEBIUS_PROJECT_ID is not set. …'),
)
```
while the identical situation for the tenant raises `MissingTenantIdError` — and the capacity file's
own doc comment brags about matching that "actionable shape". Same pattern at
`modules/resources/compute/v1/instance.ts:435` ("entered ERROR state") and `:441` ("did not reach
RUNNING within 15 minutes").

**Why it bites**: a defect cannot be `catchTag`'d, retried, or classified by the caller — and a VM
that fails to boot in 15 minutes is a *runtime outcome*, not a programmer error.

**Fix**: `MissingProjectIdError` (reuse the `resolveTenantId` guidance style),
`InstanceUnhealthyError`, `InstanceStartTimeoutError` in the typed channel. Keep `Effect.die` for
genuinely unreachable states, and say so in a comment at `kubernetes-adapter.ts:93`.

**Acceptance**: each of the four sites has a tagged error with a test asserting `.catchTag`
recovers; `grep -rn "Effect.die(new Error" modules/` returns only documented unreachable-state cases.

**Met, with two honest notes.** The three converted sites:

- `capacity/v1 actions.ListCapacityAllowances` → **`MissingProjectIdError`** (new
  `modules/resources/shared/project.ts`, mirroring `MissingTenantIdError`'s guidance shape).
- `compute/v1 instance.ts` “entered ERROR state” → **`InstanceUnhealthyError`**.
- `compute/v1 instance.ts` “did not reach RUNNING” → **`InstanceStartTimeoutError`**.

The adapter's `die` is kept and documented (R-07's note), and so is `api-client/iam.ts`'s “Issue returned
neither an operation nor a name” — a server that breaks its own contract, which R-09's own rule (“keep
`Effect.die` for genuinely unreachable states”) covers. The acceptance grep now returns **exactly one**
line: the documented adapter `die`.

**Note 1 — the raise sites are covered, except one.** The two instance errors are driven through the real
`waitForInstanceState` (exported for tests, with an injectable `deadlineMs` — the same seam
`startCallbackServer` has for `timeoutMs`, because 15 minutes of wall clock is not a unit test): the
timeout branch with `deadlineMs: 0`, the `ERROR` branch with a mocked `instance.get`, both asserting
`catchTag` recovery. `MissingProjectIdError`'s test asserts the error and its guidance, **not** the raise
site: `ListCapacityAllowances` is an `Alchemy.Action`, and every action test in this repo targets a pure
helper, so driving it means building an action harness first. Recorded in the test file too.

**Note 2 — three same-shaped sites are left, and they use a *string* `die`:**
`iam/v1 invitation.ts:64`, `iam/v1 static-key.ts:140`, `iam/v2 access-key.ts:178` all raise
`Effect.die(\`…\`)` when a live resource vanished out of band and cannot be re-created (the one-time secret
is gone). By R-09's own reasoning these are runtime outcomes, not programmer errors, so they want a
typed error — one shared `ResourceVanishedError` (with `resourceType` + `message`, no id field, so no
polymorphic-brand question) would serve all three. Left out of this change to keep it reviewer-sized;
they are invisible to the acceptance grep because it matches `new Error(`, which is exactly the kind of
narrow check this issue exists to distrust.

---

### R-10 — 91 `as unknown as` casts leave every service boundary unchecked · `OPEN`

**Files**: `modules/api-client/iam.ts` (15), `vpc.ts` (8), `compute.ts` (7), `mk8s.ts` (3),
`kms.ts`/`dns.ts`/`ai.ts` (2 each), plus `resources/**` for the DCE-guard pattern.

**Evidence**: each `makeXService` ends with `… }) as unknown as ProjectService`, and
`mapInput: Partial<Record<keyof Raw, (req: any) => any>>` types every handler's argument `any`.
Only the *keys* are checked; the request shape passed to `fromPartial` is not.

**Why it bites**: a schema method rename or a wrong request message compiles and fails at runtime.
`AGENTS.md` allows the `callMethod<T>`/`grpcClient.call()` exceptions — this is a different,
undocumented 91-site surface.

**Fix** (incremental, do not big-bang):
1. Replace `mapInput`'s `(req: any) => any` with a typed builder map inferred from the service
   descriptor, so only genuinely polymorphic entries need a cast.
2. Add one shape assertion per service (`satisfies` on a `Record<keyof XService, …>` of builder
   signatures) so the final cast has a checkable edge, then drop `as unknown as` where the
   assertion makes it unnecessary.
3. Record the remaining casts, with a reason, in `AGENTS.md` §No `any` as an approved-exception
   register.

**Acceptance**: `grep -rc "as unknown as" modules/api-client/ | sum` strictly decreases and every
survivor is listed in `AGENTS.md`; `bun run check` clean.

---

### R-11 — `paginateAll` loops forever on a repeated `nextPageToken` · `DONE (2026-09-25)`

**File**: `modules/api-client/grpc-utils.ts:627-641`

**Evidence**: `do { … pageToken = response.nextPageToken } while (pageToken)` — no page cap and no
guard against a token that repeats. `listMethod: (req: any) => …`.

**Why it bites**: one misbehaving list endpoint becomes an unbounded allocator inside
`alchemy unsafe nuke`.

**Fix**: track the previous token and fail with a tagged error if it repeats; add a `maxPages`
bound (default generous, e.g. 1000) with an actionable message.

**Acceptance**: a test with a stub returning the same token twice fails fast with the tagged error
and a bounded call count.

**Fixed**, with one deliberate deviation from the fix as written: the loop stops with a **defect**
(`Effect.die`) carrying a `PaginationLoopError`, not with a typed failure. The request was well-formed
and the server broke its own contract, so no caller has a recovery to offer — and adding the error to
`paginateAll`'s channel would have widened the error type of **all 49 call sites** (every `list` in every
service, and everything that composes them) for a condition none of them can act on. A defect still
fails loudly, naming the token and the page count. `MAX_PAGES` (1000 — 100k items at the usual
`pageSize`) bounds an endpoint whose tokens are always fresh; a token that repeats the one it was given
stops the loop immediately, which is the case `do { … } while (pageToken)` could not see.

**Met** — two tests: a stub offering the same token twice fails with
`PaginationLoopError{pageToken: 'same-token', pages: 2}` after exactly **2** calls, and an
"always-fresh token" stub stops after exactly `MAX_PAGES` calls.

**Negative control (run, and stronger than expected)**: with the guards removed the tests do not fail —
they **never return**. The unguarded loop starves the runtime badly enough that it ignores a test
timeout and emits no output (the verification command had to be killed), which is a better picture of
the bug than the issue's "unbounded allocator" phrasing: it is a hang that cannot be interrupted from
inside the process.

---

### R-12 — Tenant fan-out: no memoization, no concurrency · `OPEN`

**File**: `modules/resources/factory.ts:386-395` (`makeTenantScopedList`)

**Evidence**: `config.projectList(iam, tenant)` (`:392`) runs inside every resource type's `list`,
with no cache anywhere in `factory.ts` (`grep -n "cached\|Cache\|memo"` → none), and the fan-out uses
`Effect.forEach(projects, …)` with no `concurrency` option, i.e. sequential.

**Why it bites**: `alchemy unsafe nuke` across 40 families and *M* projects issues `40 × (1 + M)`
sequential list RPCs, where `40 × M` are unavoidable but `40` are pure duplication.

**Fix**: `Effect.cached` the project list on the tenant/transport layer (it is stable for a deploy),
and add `{ concurrency: 'unbounded' }` to the fan-out — with a bounded variant if the API rate-limits.

**Acceptance**: a test asserting the project list is fetched **once** across two different resource
types' `list` calls; a test asserting the per-project calls overlap (or that concurrency is
explicitly configured).

---

### R-13 — A unit test really sleeps ~1 s to cover a backoff default · `DONE (2026-09-25)`

**File**: `tests/api-client/grpc-utils.test.ts:683-703`

**Evidence**: the test deliberately takes the real default path (`initialBackoff ?? 1000`, no
options), so the suite pays 0.5–1 s of wall clock. The *intent* is right (the comment explains that
the no-options path would otherwise be unobserved — and R-03 shows why that matters); the *tool* is
wrong.

**Fix**: make the delay injectable (accept `Duration.Input` and provide `Effect.sleep` through a
seam, or use `TestClock`) and `TestClock.adjust` past it. Fold into R-03's work.

**Acceptance**: the test asserts the default backoff **value** rather than waiting for it; `bun test
tests/api-client/grpc-utils.test.ts` reports no test over ~50 ms.

**Fixed** by taking R-13's `TestClock` branch, folded into R-03. The three retry tests fork the effect,
`TestClock.adjust('1 hour')` and `Fiber.join`, then assert the **virtual gaps** between attempts:
500–1000, 1000–2000 and 2000–4000 ms for the defaults (which pins `initialBackoff ?? 1000` — the
mutation `&& 1000` makes the delay `NaN` and the retry never fires), plus the two `maxBackoff` windows.
They now take 10–19 ms each instead of ~1 s of wall clock, and they observe the schedule *exactly*
rather than merely waiting it out.

**Met, with one honest exception**: the file's remaining slow test is
`pollOperation > polls until the operation finishes` (~980 ms). That is `pollOperation`'s own poll
interval against an in-process gRPC server, not a sleep in a unit test — virtualising it means
threading a clock through `pollOperation` too, so it is recorded here as a follow-up rather than
smuggled into this change. Every test this issue named is under 20 ms.

**A v4 gotcha worth recording** (it cost a debugging round): a `Fiber` is **not** an `Effect` in Effect
v4 — `Effect.fork` is gone in favour of `Effect.forkChild`, and the fiber must be `Fiber.join`ed before
`Effect.exit`/`Effect.race` can be given it, otherwise the run fails at the *runtime* with
`Fiber.runLoop: Not a valid effect: [object Object]`, which names neither the call nor the type.

---

### R-14 — Loopback callback URL built from the untrusted `Host` header · `DONE (2026-09-25)`

**File**: `modules/auth/oauth.ts:116`

**Evidence**: `new URL(req.url ?? '/', \`http://${req.headers.host ?? '127.0.0.1'}\`)`.

**Why it bites**: contained today — `state` is validated, PKCE is real, and no redirect is built
from the parsed value — but it is one copy-paste away from an open redirect, and the surrounding
code is careful enough that this stands out.

**Fix**: hardcode the origin (`http://127.0.0.1`) when parsing the loopback request; the server
already binds only to `127.0.0.1`.

**Acceptance**: a test asserting a request with a hostile `Host` header still parses `code`/`state`
from the raw query and cannot influence any redirect target.

**Met, and hardened past the prescribed fix.** The request target is no longer parsed as a URL at all:
the handler takes the substring after `?` into a `URLSearchParams`, so there is **no origin in the code**
for anyone to get wrong — the prescribed "hardcode `http://127.0.0.1`" would still construct a URL whose
base someone could later use. The test sends `Host: evil.example.com` through `node:http` (not `fetch`,
which silently drops `Host` as a forbidden header) and asserts the success redirect is the constant and
the code still resolves.

**Measured, and worth stating plainly**: that test **passes against the old header-derived code too**. It
asserts the two things the acceptance names — hostile `Host` still parses the query, and it cannot
influence the redirect — but it is *not* a regression guard, because today nothing reads the parsed
origin at all. The change removes a landmine; it does not change behaviour, and no behavioural test can
say otherwise. A guard for this would have to be a source-level one, which is the kind of mechanism this
repo retired on purpose.

---

## MEH — annoying but survivable

### R-15 — Branded-ID audit is informational, and its count drifts · `DONE (2026-09-25)`

**Files**: `tools/schema-conformance.ts:163` · `AGENTS.md` §"Branded IDs — everywhere, inputs and
outputs" · `modules/resources/dns/v1/zone.schema.ts:85`

**Evidence**: only the casing check exits non-zero (`:163` gates `caseFailures`). The brand section
is printed as raw candidates and can never fail. Meanwhile `AGENTS.md` states **13** remain while
```
$ bun tools/schema-conformance.ts   # BARE-STRING ID FIELDS
   → 16 lines
```
At least 3 are false positives (`ai/v1/bindings.ts:85,114` are SSE frame helpers, not schemas) — so
the doc's number is hand-maintained and nothing re-validates it. One candidate looks like a real
miss: `zoneId: Schema.String` in `ZoneNotEmpty`, built from `output.id` at `zone.ts:154`.

**Fix**: add an explicit allowlist file (path + field + reason, one line each) that the tool reads;
**exit 1** on any candidate not in it. Update the `AGENTS.md` count from the tool's own output, or
delete the count and point at the tool. Split the scan so non-schema files (`bindings.ts`) are
excluded or require an allowlist entry with a reason.

**Acceptance**: introducing a new `id: Schema.String` in a props/attributes/error schema fails
`bun tools/schema-conformance.ts`; the printed total matches `AGENTS.md`.

**Met, with a deliberate deviation from the fix as written**: no separate allowlist file. The audit now
exits 1 on any bare-string ID field whose **own leading doc comment** lacks the literal marker
`NOT branded: <why>`, and the check runs in `bun run check` (`bun run conformance`). An allowlist file
was rejected because 14 of the 16 candidates already carried an in-place explanation —
“NOT a Nebius resource ID”, “deliberately unbranded”, “unbranded: `''` = auto-allocate” — so a second
file would have duplicated every reason verbatim *and* needed a staleness check (a renamed field would
silently approve nothing). The in-code marker travels with the field, cannot go stale, and makes
`grep -rn "NOT branded" modules/resources/` the complete exception inventory; the tool prints the same
list as its report. Seven comments were reworded to the marker (no behaviour change), and the marker is
the *literal* string, not a family of “unbranded”-ish wordings — the loose-pattern failure mode this
repo has been bitten by twice (R-05, R-06).

**`AGENTS.md` no longer states a count** (it said 13 while the tool printed 16): it points at the tool,
which prints the live total, and at the grep. The paragraph also gained the one shape the old exception
list did not name — see R-16.

**Met** — running the tool with a `sneakyNewId: Schema.String` added to a schema schema exits **1** and
names the field and its line, with the instruction to brand it or say why not; removing it exits 0.
The classifier is pinned by 9 tests in `tests/tools/schema-conformance.test.ts`, four of which are
negative controls: a marker on the *neighbouring* field, a marker separated by a blank line, a marker
elsewhere in the file, and the three near-miss wordings the repo used to write. All four would look
identical from the outside if the marker search were file-wide.

---

### R-16 — `ZoneNotEmpty.zoneId` is an unbranded id while `ZoneId` exists · `DONE (2026-09-25)`

**File**: `modules/resources/dns/v1/zone.schema.ts:85` (brand in `modules/resources/dns/v1/ids.ts:6`)

**Evidence**: `zoneId: Schema.String` inside an exported error schema, populated from `output.id` at
`modules/resources/dns/v1/zone.ts:154`. The brand is declared one file away and re-exported.

**Fix**: `zoneId: ZoneId`. **Acceptance**: `R-15`'s audit no longer lists it; the `ZoneNotEmpty`
construction site type-checks without a cast.

**Fixed — and it was two sites, not one.** `dns/v1 ZoneNotEmpty.zoneId: Ids.ZoneId`, and the identical
miss one service over: `billing/v1 PricingPolicyHasRunningVms.id: Ids.PricingPolicyId`. Both are error
schemas carrying the resource's own id, both populated from a branded `output.id`, and both sat 11–22
lines below an *attributes* schema that already used the brand for the same value (`ZoneAttributes.id`,
`PricingPolicyAttributes.id`) — so the brand was being thrown away precisely where an operator reads
it, in the error that says why their destroy was blocked. Neither needed a cast at the construction
site: `output.id` was already branded, which is why the unbranded field compiled.

Recorded as a finding rather than a one-line fix because the issue called this “one candidate”: the
roast's candidate list was read by eye against a count that had already drifted, which is the failure
R-15 exists to remove. `AGENTS.md` §"Branded IDs" now names error schemas explicitly, and the tool
enforces it (the marker cannot approve a branded field into silence — it simply stops being reported).

---

### R-17 — 41 copies of `eslint-disable-next-line require-yield` · `DONE (2026-09-25)`

**Files**: every provider file with an `Effect.fn` generator whose `diff` contains no `yield`
(e.g. `modules/resources/kms/v1/asymmetric-key.ts:133`).

**Evidence**: `grep -rc require-yield modules/ | sum` → 41; all are the same false positive.

**Fix**: one override in `.oxlintrc.json` (`require-yield: off` for the provider glob, with a comment
saying `Effect.fn` generators are not plain generators), then delete the 41 comments.

**Acceptance**: `grep -rc require-yield modules/` → 0 and `bun run lint` unchanged.

**Met** — all 41 comments deleted (41 files, one line each, no formatting artefacts) and replaced by one
override in `.oxlintrc.json` (`"files": ["modules/**"], "rules": { "require-yield": "off" }`).
`grep -rn require-yield modules/` → **0**; `bun run lint` is identical to the pre-change baseline
(re-verified by diffing the diagnostic sets, not by reading the exit code).

**But the issue's premise is wrong in a way worth recording.** The 41 were not suppressing a *false
positive*; they were suppressing **nothing**. With all 41 removed and *no* override in place,
`bun run lint` reported **zero** `require-yield` diagnostics. Every one had gone stale: they were written
when provider `diff` bodies were pure `return AlchemyDiff.deepEqual(...)`, and the plan-time validation
sweep later gave every `diff` a `yield* XSchema.validateXProps(news)`.

Two measurements, because “the rule cannot see this form” and “the comments do nothing” are different
claims, and the repo has been bitten by the first one already (R-05):

- **The rule does see the idiom.** `Effect.fn('x')(function* () { return 1 })`, the bare-expression form
  and a function declaration are all reported in a scratch file — so this is *not* another matcher that
  cannot see what the repo writes.
- **No comment was load-bearing.** Precisely *because* the rule fires on that form, deleting all 41 while
  leaving the rule enabled is a complete test: any `diff` still lacking a `yield` would have failed that
  lint run. None did.

The override is still the right landing place — it stops the next `diff` that loses its `yield*` from
producing the 42nd comment — but its reason is not “the rule is blind”: it is that an `Effect.fn` body is
driven by Effect rather than iterated by the language, so a `yield`-less one is legitimate here. Both
facts are in the config comment, and the scope is verified in both directions (`modules/scratch-ry.ts` →
exit 0; the same file at the repo root → still reported).

**Follow-up recorded, not built**: oxlint 1.83 has no `reportUnusedDisableDirectives` (absent from both
`--help` and `configuration_schema.json`), so an `eslint-disable` that suppresses nothing is invisible to
the tooling — which is how 41 of them survived. A `nebius/` rule could flag a disable for a rule that is
not enabled or does not exist; it would have caught this in one run, and it needs the plugin's own
fixtures (R-04) to be worth trusting. Worth doing the next time the plugin is touched.

---

### R-18 — The maintainer's real project id is committed in 9 places · `OPEN`

**Files**: `tests/api-client/mk8s-requests.test.ts:30` · `tests/api-client/nvl-instance-group-list.test.ts:15,18` ·
`tests/resources/actions/capacity-discovery.test.ts:108,305,337,370,371`

**Evidence**: `project-e00eq4g7pr00j746m1fttd` — the local `.env` value, hardcoded in tracked test
fixtures used as opaque strings.

**Fix**: one exported fixture constant (e.g. `tests/helpers/fixtures.ts` →
`TEST_PROJECT_ID = 'project-test-1'`, matching `tests/helpers/mocks.ts:38`) and use it everywhere.
`project-1` already appears in the same file (`nvl-instance-group-list.test.ts:24`) — pick one.

**Acceptance**: `grep -rn "project-e00eq" tests/ → 0`.

---

### R-19 — `quoteEnvValue` turns a newline into literal `\n`; no round-trip test · `OPEN`

**File**: `modules/resources/compute/v1/hosted.ts:544-548` (consumed as a systemd `EnvironmentFile`
at `:690`)

**Evidence**: `text.replaceAll(/\n/g, '\\n')` inside a **single-quoted** value; the test pins the
string (`tests/resources/compute/v1/hosted.test.ts:57`) but nothing pins a round-trip. Whether
systemd unescapes `\n` inside single quotes decides whether a multi-line value (a PEM in `env`)
reaches the VM intact.

**Fix**: determine the behaviour from the systemd documentation **and** a live instance, then either
model it correctly or reject multi-line env values at build time with a clear error. Either way, add
the assertion.

**Acceptance**: a test that fails if a newline-bearing env value does not round-trip through the
generated `EnvironmentFile` on a real VM (or a documented plan-time rejection with a test).

---

### R-20 — Create-failure recovery does not classify the failure first · `OPEN`

**Files**: `modules/resources/compute/v1/instance.ts:561-575` · `modules/resources/ai/v1/endpoint.ts:230-245`
(and `ai/v1/job.ts:98-106`)

**Evidence**: `.pipe(Effect.catch((e) => … getByName …))` — an `INVALID_ARGUMENT` (bad spec) still
triggers the lookup before re-failing.

**Fix**: only attempt recovery for the failures that can hide a successful create —
`DEADLINE_EXCEEDED`, `INTERNAL`, `UNAVAILABLE`, `ABORTED` (and `ALREADY_EXISTS`); re-raise everything
else immediately.

**Acceptance**: a test asserting `INVALID_ARGUMENT` makes exactly one call (no `getByName`), and a
test asserting `DEADLINE_EXCEEDED` still recovers.

---

### R-21 — Static keys are project-parented, but `list` queries per service account, so nuke cannot see them · `OPEN`

**Files**: `modules/resources/iam/v1/static-key.ts` (`create`, `list`)

**Evidence**: found live 2026-09-25 by `spikes/idempotency-key-probe.ts`. An `Issue` carrying
`metadata.parentId = <project>` creates a key whose `metadata.parentId` **is the project**:

```
keys live: {"byProjectParent":2,"bySaParent":0,"probeParents":["project-e00eq4g7pr00j746m1fttd", ...]}
```

An immediate `list(serviceAccountId)` — the form the provider uses — returned **0**, and the API's own
`ALREADY_EXISTS` message names the project ("already exists in project-…: statickey-…").

**Why it bites**: `Nebius.iam.v1.StaticKey.list` fans out project → service accounts →
`staticKey.list(sa.id)`, so it can never see a key the same code created. That list is what
`alchemy unsafe nuke` enumerates, so a nuke would report a clean tenant while leaving every static key
behind — and a static key is a long-lived credential (6 months by default, up to 3 years). The
provider's comment ("Static keys are per-service-account, not per-project") is the belief the
measurement contradicts.

**Fix (one measurement chooses the direction)**: either `list` the keys by **project**
(`staticKey.list(project.id)`), or `Issue` with `metadata.parentId = serviceAccountId` so the key really
is SA-parented — the probe only measured the project-parented create. Issue one key each way, list both
ways, then align `create` and `list` on whichever parent the API honours. (Also watch the SA delete: run
1's key disappeared with its deleted service account, so a cascade may already be covering part of this.)

**Acceptance**: a `list` that returns a key the same code created — pinned by a live probe recording
both the create and the list parent, not by a mapper unit test (the parent semantics are the API's).

---

## Suggested sequencing

1. **R-04 + R-05 + R-06 — all done 2026-09-25** — fix the guardrails, with the self-test that proves the
   fix. This step is complete: the harness proves the rules, `Effect.ignore` and the constant-handler class
   are both enforced at `error`, and all 32 swallows are classified. Next is step 2 below.
2. **R-03, R-13, R-11, R-17** — small, offline, no behavioural risk; batch into one commit. **All done**
   (2026-09-25: R-03 + R-13 + R-11 in one `grpc-utils.ts` pass; R-17 the config entry that replaced 41
   stale disable comments).
3. **R-02, R-07, R-09, R-14** — error-shape corrections, each independently testable. **R-02, R-07, R-09
   and R-14 are all done** (2026-09-25). R-02 is the reference implementation for R-06's 31-site
   classification.
4. **R-01 — done 2026-09-25** — the only HIGH-risk item, and the probe is what settled it: the API does
   **not** dedupe on `x-idempotency-key` (duplicate `Issue` → `ALREADY_EXISTS`, both completed and in
   flight), so branch 1 is a dead end and mutations are no longer retried at all. See the DONE section.
   The probe also exposed **R-21** (static keys are project-parented; `list` queries per service account).
5. **R-19** — needs a live instance; pair with any other live probe session.
6. **R-10, R-12, R-15, R-16, R-18, R-20, R-21** — incremental cleanups, safe to interleave. R-15 + R-16 are
done (2026-09-25; R-16 turned out to be two sites — an error schema in `billing/v1` had the same
miss), and R-21 was found by R-01's probe (2026-09-25).
7. **R-08** — last, because it is a large refactor over the file most likely to change for other
   reasons. Do it when the rest is quiet.

## Do not "fix" these — they are approved exceptions

Recording them here so a future sweep does not re-litigate them:

- The `grpcClient.call()` / `callMethod<T>()` `any` sites (`AGENTS.md` §No `any`).
- The `__ALCHEMY_RUNTIME__` DCE guard (`modules/resources/storage/v1/bucket.ts` is the reference copy).
- `tests/**` calling the real `AlchemyDiff.deepEqual` — it pins the framework trap itself.
- `Effect.die(new Error(…))` for genuinely unreachable program states, once documented as such
  (the R-07/R-09 work separates these from runtime outcomes). `paginateAll`'s `PaginationLoopError` is
  the second of the shape: a list endpoint that repeats a page token or never terminates is a broken
  server, not a caller-recoverable condition (R-11).
- The declared-but-non-converging props listed per resource in `tests/convergence.test.ts`.
