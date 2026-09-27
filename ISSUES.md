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
| R-22 | EYE ROLL | modules/** | "Nebius does not cascade-delete associated resources" was asserted in 8 providers and is false for the IAM family | M | LOW |
| R-23 | MEH | spikes/** | R-18's leak sweep was scoped to `tests/`, so the maintainer's real project id sits in 23 tracked spike files (and once in this file) | S | LOW |
| R-24 | MEH | compute/hosted | A newline (or `=`) in an env **key** is silently misparsed, and the value-only fix for R-19 left it alone | S | LOW |

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

- **`modules/resources/actions/shared.ts`'s `listProjectIds` was dead** — zero references in `modules/`,
  `tests/` or `examples/`; the action files inline the same `parentId ? [parentId] : (yield*
  iam.project.list(tenantId)).map(…)` expression instead. **Resolved 2026-09-25**: the file was deleted
  rather than adopted, because the helper's shape is the *pre-R-06* one (it propagates on any failure and
  bakes in `metadata!.id`), while the callers it would have absorbed have split into two deliberately
  different treatments (`iam/actions.ts`'s `ListProjects` narrows and re-raises; the fan-out sites pass
  parents to `bestEffortList`). The duplication was real though — **7 sites in 3 files**, not three — and
  is now `resolveParentIds` in `shared/fan-out.ts`.
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

### R-18 — The maintainer's real project id is committed in 9 places · `DONE (2026-09-25)`

**Fixed**: one exported fixture, `TEST_PROJECT_ID = 'project-test-1'` in `tests/helpers/fixtures.ts`
(the value `tests/helpers/mocks.ts` already used), replacing all 9 occurrences across
`tests/api-client/mk8s-requests.test.ts`, `tests/api-client/nvl-instance-group-list.test.ts` and
`tests/resources/actions/capacity-discovery.test.ts`. The fixtures file's comment names the leak but
deliberately does **not** repeat the literal, so the acceptance grep stays at zero.

**Met, and the sweep was too narrow** (see R-23): `grep -rn "<the project-id literal>" tests/` → **0**.

**Files**: `tests/api-client/mk8s-requests.test.ts:30` · `tests/api-client/nvl-instance-group-list.test.ts:15,18` ·
`tests/resources/actions/capacity-discovery.test.ts:108,305,337,370,371`

**Evidence**: the local `.env` project-id value — not reproduced here (R-23: this line *was* one of the
24 tracked copies, and the only one in a non-`tests/` file that R-18's acceptance did not look at), which
was hardcoded in tracked test fixtures used as opaque strings.

**Fix**: one exported fixture constant (e.g. `tests/helpers/fixtures.ts` →
`TEST_PROJECT_ID = 'project-test-1'`, matching `tests/helpers/mocks.ts:38`) and use it everywhere.
`project-1` already appears in the same file (`nvl-instance-group-list.test.ts:24`) — pick one.

**Acceptance**: `grep -rn "<the project-id literal>" tests/ → 0`. **Widened by R-23** to the whole tracked
tree — a path prefix was the scope, not a rule, and `spikes/` is where the literal actually survived.

---

### R-19 — `quoteEnvValue` escaped newlines into a literal `\n`, which systemd reads back corrupted · `DONE (2026-09-25)`

**Fixed**: one line. `quoteEnvValue` no longer rewrites a newline to a literal `\n` — a quoted newline is
kept **verbatim**, which is how a multi-line value is transported:

```ts
- return `'${text.replaceAll(/'/g, `'""'`).replaceAll(/\n/g, '\\n')}'`
+ return `'${text.replaceAll(/'/g, `'""'`)}'`
```

**File**: `modules/resources/compute/v1/hosted.ts` (`quoteEnvValue`, `renderEnvFile`) ·
`tests/resources/compute/v1/hosted.test.ts`

**The reading — and it inverted the fix.** The issue framed this as "either model it correctly or reject
multi-line env values at build time", and assumed the encoding was at best unknown. Reading systemd's
parser at the **target image's own version** (Ubuntu 24.04 ships systemd **v255**) shows the format *can*
carry a newline, and that the old encoder was the thing breaking it:

| reading | source |
| the parser has **no escape** that produces a newline: `SINGLE_QUOTE_VALUE` treats only `'` specially and appends **every other character verbatim**; `DOUBLE_QUOTE_VALUE_ESCAPE` unescapes only `SHELL_NEED_ESCAPE` (`"`, `\`, `` ` ``, `$`) and *keeps* the backslash on `\n`; unquoted `VALUE_ESCAPE` **drops** it | `src/basic/env-file.c` v255 (`SINGLE_QUOTE_VALUE`/`DOUBLE_QUOTE_VALUE`), and a man-page patch upstream: "Remove incorrect claim that C escapes … are recognized" |
| a **real** newline inside quotes is appended verbatim, so a multi-line value round-trips | same state machine: neither quoted state has a `NEWLINE` case |
| systemd asserts that itself: `load_env_file_6` writes a single-quoted value spanning two file lines and asserts it reads back with a real newline and every backslash intact | `src/test/test-env-file.c` (v255 and main) |
| `EnvironmentFile=` uses that same parser — `src/core/execute.c` calls `load_env_file` → `parse_env_file_internal` | `src/core/execute.c:773` (v255) |

So `'line1\nline2'` (the old output) read back as `line1\nline2` — a **literal backslash and `n`**, silently
— and `'line1<real newline>line2'` reads back as the two lines the user wrote. A PEM in `env` was
corrupted on every deploy; the same value is now transported intact.

**A rejection was prototyped first, and deliberately thrown away.** Before reading the parser's quoted
states I built the second branch the issue allows: a `HostedEnvNotRepresentableError`, a plan-time guard
in `instance.ts` (`diff` + `reconcile`) and a compose-time backstop in `uploadHostedArtifacts`, plus a
D8-safe shared module to hold them (`instance.ts` may not import `hosted.ts` statically — rolldown/vite
in every runtime bundle). It passed its tests and was wrong: the format carries the value, so rejecting it
would have *forbidden a PEM in `env`* while the actual bug stayed. Recorded here because the discarded
version is the tempting one from the issue text, and because **R-24** now needs that machinery for the
case that genuinely cannot be represented.

**Acceptance** (the issue's second branch was "or a documented plan-time rejection with a test"; the fix
turned out to be the first, so the test pins the round-trip):
- `tests/resources/compute/v1/hosted.test.ts` → `keeps a real newline inside the quotes — a multi-line
  value IS transportable`: asserts the emitted form, the real newline, and — as the negative control —
  `expect(...).not.toContain('\\n')`, so the escaping idiom cannot come back.
- `a multi-line value keeps working when it also contains quotes`: the `'` → `'""'` dance across lines.
- **Negative control (run, not asserted)**: against the pre-fix encoder both tests fail, exactly as they
  should (they are the only two failures in the file).
- `bun run check` clean, `bun test` 1667 pass / 0 fail.

**No live VM was needed, and the reason is stated rather than assumed**: the behaviour is systemd's parser,
not the image's configuration — v255 *is* the target's version, `EnvironmentFile=` provably uses that
parser, and systemd's own test suite pins the quoted-newline case. A VM run would corroborate, not decide.

---

---

### R-20 — Create-failure recovery does not classify the failure first · `DONE (2026-09-25)`

**Fixed**: new `isCreateRecoveryCandidate(error)` in `modules/api-client/grpc-utils.ts` — `true` for
`GrpcDeadlineExceededError` (code 4, which surfaces as that distinct typed error) and `GrpcError` codes
`ALREADY_EXISTS` (6), `ABORTED` (10), `INTERNAL` (13), `UNAVAILABLE` (14); `false` for everything else.
The create-recovery blocks in `compute/v1/instance.ts`, `ai/v1/endpoint.ts` and `ai/v1/job.ts` now
`return yield* Effect.fail(e)` before the `getByName` lookup when the predicate is false — so
`INVALID_ARGUMENT` (a bad spec) re-raises immediately instead of running a lookup that can only produce a
wrong diagnosis. (`endpoint.ts`'s "attempting recovery" warning sits behind the guard too, so it never
narrates a recovery that will not happen.)

**Met**:
- `tests/api-client/grpc-utils.test.ts` — the predicate directly: every recovery code in, every other
  code out, plus non-gRPC values.
- `tests/resources/ai/v1/job.test.ts` (`describe('reconcile — create-failure recovery (R-20)')`) drives the
  **real** reconcile with a mocked AI service: `INVALID_ARGUMENT` → exactly 1 `create` call and 0
  `getByName`; `DEADLINE_EXCEEDED` → 1 `getByName` and the recovered job is adopted.

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

### R-21 — Static keys are project-parented, but `list` queried per service account · `DONE (2026-09-25)`

**Fixed, in two halves — the second one is what makes the first safe**:

1. `Nebius.iam.v1.StaticKey.list` now enumerates **by project** — the container `create` issues into —
   via `Factory.makeTenantScopedList`, the same helper the sibling with this exact proto shape
   (`metadata.parentId` + `spec.account.serviceAccount`) already uses. The project → service account →
   key fan-out is gone, which also removes one RPC per project from an enumeration that walks every
   family in the tenant.
2. `create` now sends the `alchemy::*` ownership labels. Fixing the parent **alone** would have been a
   destructive regression: `list` is what `alchemy unsafe nuke` walks, and nuke deletes every target a
   provider's `list` returns with no further ownership check (`Nuke.ts` → `provider.delete({ output:
   attributes })`; `makeCrudDelete` has no ownership test). A project-scoped list is only safe because
   `makeTenantScopedList` withholds anything without an `alchemy::` label — `isDefaultResource`:
   "system resources untouched by Alchemy have no labels → default" — and these keys were issued with
   **no labels at all**, so the corrected list would have returned every static key in every project
   of the tenant, including ones no Alchemy stack ever created. With the tags, the same filter that
   protects the other 28 resources protects this one.

**Files**: `modules/resources/iam/v1/static-key.ts` (`create`, `list`, `nuke`) ·
`modules/api-client/iam.ts` (the `StaticKeyService.list` contract, which documented the wrong
container) · probe `spikes/static-key-parent-probe.ts`

**The measurement decided the direction, and the API answered in one line.** Both branches of the
question ("list by project" vs "issue with `parentId = serviceAccountId`") collapse, because the API
refuses the second outright:

| arm | request | result |
| A | `Issue(parentId = PROJECT)` | accepted → `statickey-e00ar9y0wacwbqbzb7`, `metadata.parentId` echoed back as the **project**, no labels |
| B | `Issue(parentId = SA)` | `3 INVALID_ARGUMENT: Expected type of nid should be one of project, aiproject, tractotenant, but found serviceaccount` |
| C | `Issue(parentId = PROJECT, labels = alchemy::*)` | accepted; `metadata.labels` comes back **verbatim** (`alchemy::id`/`stack`/`stage`) |
| — | `list(PROJECT)` | returns A **and** C (2/2) |
| — | `list(SA)` | **returns nothing** (`totalReturned: 0`), including after the SA-parented issue was refused |
| — | `getByName(PROJECT, name)` | finds key A |
| — | `getByName(SA, name)` | `5 NOT_FOUND` |
| — | **`Factory.makeTenantScopedList` with this service** (i.e. the fixed `list`) | `{taggedVisible: true, untaggedWithheld: true}` — returns C, withholds A |

So the container is the project, unambiguously: `Issue` will not accept a service-account `nid`
at all. The proto is what misled the original implementation — `GetStaticKeyByNameRequest.parent_id`
is documented as "id of the parent container (**service account**)", and that comment is **wrong for
this service** (`getByName` by project finds the key; by SA answers `NOT_FOUND`), while
`ListStaticKeysRequest.parent_id` says only "Represents the container ID." The `spec.account.serviceAccount`
reference — not the metadata parent — is what names the account.

**Rider — the bite is narrower than this entry claimed, and the difference is measured, not argued.**
The same run deleted the service account with key A still attached: the delete **succeeded**, and a
`list(PROJECT)` five seconds later answered `[]`, with the postflight confirming the SA was gone
(`Cannot get entity with id serviceaccount-…`). So the platform cascades a static key away with the
account named in its `spec.account` — the key is not left orphaned by an SA delete. That downgrades
this from "an orphaned long-lived credential with no trace" to "an enumeration that is structurally
blind": `list` is still what `alchemy unsafe nuke` walks, so keys whose account is *not* deleted in
the same run (an adopted or externally-managed SA, a key issued for a service account outside nuke's
scope) are never reported, and a partial enumeration reading as a complete one is exactly what
AGENTS.md §"no failure may read as nothing there" forbids. The provider comment that stated the old
belief — "Static keys are per-service-account, not per-project" — is replaced by the readings above,
and `nuke`'s `dependsOn` is kept with its reason corrected (the SA delete cascades, so the ordering
is defence-in-depth rather than a requirement: an explicitly deleted credential is visible in the
destroy log instead of vanishing implicitly).

**Acceptance — met by the probe (R-21 named the API's semantics as the thing to pin, and a unit test
cannot invent them):** `spikes/static-key-parent-probe.ts` records both parents, the label echo and
the provider-shaped list in one run and prints a verdict per question;
`bun spikes/static-key-parent-probe.ts` → `PROJECT IS THE CONTAINER …`,
`alchemy::* labels are stored and echoed verbatim …`, and
`NUKE-SAFETY READING {taggedVisible: true, untaggedWithheld: true}`. The last line is the one that
matters most, and it is the reason the probe builds its list through `Factory.makeTenantScopedList`
rather than re-implementing the two calls: the factory call **is** the provider's `list`, including the
`isDefaultResource` filter that no hand-written replication would have included.

**Met, the provider-side half** (offline): `tests/resources/iam/v1/static-key.test.ts` →
`list enumerates keys by PROJECT, never by service account` asserts `staticKey.list` is called with
the project id and that `serviceAccount.list` is called **zero** times; the create test asserts the
issue request carries `alchemy::id` + `alchemy::stack` + `alchemy::stage` and a **project**
`parentId`. **Negative control (run, not asserted)**: with the pre-fix provider restored, the list test
fails at the first assertion (`listParents` = `[]`, since the fan-out only reaches `staticKey.list`
*through* a service account) — the fan-out was reachable only by reading the source, which is how it
survived until a live probe caught it. The tagging half has its own live negative control: the probe's
arm A is issued **without** labels and is withheld by the fixed list, which is exactly what would have
happened to every key had the parent been fixed without the tags — and, without the filter, exactly
what would *not* have happened, i.e. nuke deleting credentials it never created.

**Also corrected by the tags**: `read`'s `AlchemyTags.hasAlchemyTags` check could never succeed for a
key this provider issued (there were no labels to match), so every `read` answered
`AdoptPolicy.Unowned`. Keys issued before this change stay `Unowned` — unchanged behaviour, and the
reason this is a create-side fix rather than something `read` could repair.

**Live end-to-end, the whole provider path**: `SLOW_TESTS=1 bun test
tests/resources/live-echo.integration.test.ts -t "iam family"` → pass, with the six-family deploy and
destroy both clean (`Done: 6 succeeded`), i.e. a `StaticKey` created by the provider with the new
metadata still writes exactly once and its forced reconcile still writes nothing.

**Cleanup**: both probe keys and the throwaway service account are deleted and postflighted to zero
(`POSTFLIGHT {probeKeysLeft: 0, probeServiceAccountsLeft: 0}`). The probe deliberately reads
`NEBIUS_PROJECT_ID` from the environment with **no default** — every earlier probe in `spikes/`
hardcoded the maintainer's real project id, which R-18's acceptance grep (`tests/` only) did not
reach (see R-23).

---

### R-22 — "Nebius does not cascade-delete associated resources" was asserted in 8 providers and is false for the IAM family · `DONE (2026-09-25)`

**Fixed**: every one of the 8 sites now states its own dated reading instead of the sentence, and the
fleet-wide table lives in one place (AGENTS.md §"Delete cascades — measured, not assumed") so eight
copies cannot drift apart again. **No provider behaviour changed** — no `dependsOn` was added or
removed; what changed is that each ordering now has a measured reason, and two of them have a
different reason than the comment gave.

**Files**: `iam/v1/{static-key,auth-public-key,access-permit,group-membership}.ts` ·
`iam/v2/access-key.ts` · `vpc/v1/{security-rule,route}.ts` · `dns/v1/record.ts` · `factory.ts`
(`makeCrudDelete`) · probe `spikes/parent-delete-cascade-probe.ts`

**The measurement** — one throwaway parent and child per relation, then the parent delete while the
child existed, read twice (two full runs, identical):

| relation | reading | evidence |
| `ServiceAccount` → `StaticKey` (**positive control**, R-21 had already measured it) | CASCADED | child gone from `get` |
| `ServiceAccount` → `AuthPublicKey` | CASCADED | ditto |
| `ServiceAccount` → `iam/v2 AccessKey` | CASCADED | ditto |
| `ServiceAccount` → `GroupMembership` (by **member** reference, not the metadata parent) | CASCADED | ditto |
| `Group` → `GroupMembership` | CASCADED | ditto |
| `Group` → `AccessPermit` | CASCADED | ditto |
| `SecurityGroup` → `SecurityRule` | **REFUSED** | `9 FAILED_PRECONDITION: SecurityGroup … cannot be deleted because it contains rules: vpcsecurityrule-…` |
| `RouteTable` → `Route` | **REFUSED** | `9 FAILED_PRECONDITION: RouteTable … cannot be deleted because it contains static routes: vpcroute-…` |
| `Zone` → `Record` | **REFUSED** | `9 FAILED_PRECONDITION: Zone … is not empty` |

**Three classes, and the old sentence was wrong about two of them.** The IAM relations **cascade** — so
the `dependsOn` orderings there are defence-in-depth (a credential deleted explicitly and visibly
rather than vanishing implicitly), and the claim in those five files was simply false. The VPC/DNS
relations are **refused**: the parent delete fails loudly, naming the child, which is a third shape the
sentence did not describe — it is neither a cascade nor an orphan, and it is the one that *blocks* a
destroy until the enumeration finds the children. And `Factory.makeCrudDelete`'s comment ("deleting a
service account removes its group memberships and access keys") is **literally true** — the repo was
citing the correct reading in one place while eight others asserted its opposite.

**Why this is not a comment-accuracy nit.** No relation read `ORPHANED`, and that is the reading that
would have turned a blind `list` into a silent leak. `dependsOn` only orders the deletion of children
nuke can *enumerate*, so where a child's list is blind the cascade is the entire backstop: it is what
saved R-21's static keys (whose list could not see a single key this provider created) and what covers
access keys and auth public keys, which share that shape. Two consequences are now written into
AGENTS.md: a new provider whose child holds a foreign id or a parent id must take its `nuke` ordering
from a reading like this one rather than from the sentence; and a provider with a blind child `list`
may not rely on `dependsOn` alone — that combination is safe only where the relation is measured
`CASCADED`.

**Operational flip side worth knowing** (not a defect): because the IAM relations cascade, deleting a
service account by hand — in the console, or by `nuke` before it reaches the keys — silently destroys
its static keys, access keys and auth public keys. The credential stops working with no event on the
key itself.

**Acceptance**: met — `grep -rn "does not cascade" modules/` finds no assertion, only the four
historical quotations that now say the claim "used to sit here, and was wrong"; every relation has a
`CASCADED`/`REFUSED` reading with a date in its own file; `bun run check` and `bun test` clean.

**Cleanup**: `POSTFLIGHT nothing left` on both runs — 15 objects created and removed (the probe
deletes children first, then parents, re-checking existence so a cascaded object is never re-deleted,
and the shared VPC network last).

**Fixture knowledge for the next probe**: a `defaultEgressGateway` route rejects any destination
inside RFC1918 (`3 INVALID_ARGUMENT: Destination cidr … must not be within RFC1918 ranges`) — the
first run of this probe reported that arm `INCONCLUSIVE` for exactly that reason, which is why the
probe distinguishes INCONCLUSIVE from a reading rather than guessing.

**Deliberately not measured**: `iam/v1 Federation` → `FederationCertificate` (the federation is
**tenant**-scoped, so the probe would have created a tenant-level object; its `dependsOn` is left
standing unmeasured and unclaimed rather than extrapolated from the relations above).

---

### R-23 — R-18's leak sweep was scoped to `tests/`, so the real project id sat in 23 tracked spike files · `DONE (2026-09-27)`

**Fixed**: one shared helper, `spikes/spike-env.ts`, exporting `requireProjectId()`, `requireTenantId()`,
`requireSubnetId()`, `requireOtherSubnetId()` and `requireServiceAccountId()` — each reads `process.env`
and `process.exit(1)`s naming the variable and the reason, so there is no `??` left anywhere in `spikes/`
to fall through to a committed value. All 23 offenders now import it; the two probes that already carried
the inline guard (`static-key-parent-probe.ts`, `parent-delete-cascade-probe.ts`) were folded into it so
there is exactly one copy; the `ISSUES.md` literal is gone.

Three things the sweep turned up beyond the entry's own scope, all the same class:

- **The tenant id was committed too** (`tenant-e00…` in `spikes/cpu-presets.ts` and
  `spikes/capacity-blocks-probe.ts`) — the value that decides which tenant `alchemy unsafe nuke` fans out
  across. Removed like the project id; `requireTenantId()` names where to get it.
- **The subnet and service-account ids were committed** (`vpcsubnet-e00…` in 13 files,
  `serviceaccount-e00…` in 10) — not credentials, but a committed default is the same silent choice. Both
  now come from the helper, and `mk8s-write-probe.ts`'s *second* subnet — the one it changes `subnetId`
  **to** — is `NEBIUS_SUBNET_ID_OTHER`, which is what makes the two distinguishable to a reader.
- **`NEBIUS_SA_ID` could not be reused as the probe's variable name**: that is Alchemy's own SA-key
  credential variable, and `AuthProvider.ts` records that setting only part of the triple (`NEBIUS_SA_ID` +
  `NEBIUS_SA_KEY_ID` + `NEBIUS_SA_PRIVATE_KEY`) “hijacked resolution and killed provider loading”. A probe
  whose error message told you to export `NEBIUS_SA_ID` would have broken the deploy it was probing, so the
  probe's variable is `NEBIUS_SERVICE_ACCOUNT_ID` and the helper says why. `NEBIUS_TENANT_ID` is the mirror
  case in the other direction: production code reads that name, so it is documented as an export-for-the-run
  variable rather than being written into the shared, gitignored `.env` — a stale tenant there would not
  fail loudly the way a stale subnet id does, it would enumerate the wrong tenant. The local `.env` gained
  the three probe-only values so the existing probes keep running.

**Acceptance (run)**: the literal is gone from the whole tracked tree —
`git grep -nE "project-e00[0-9a-z]{10,}" | wc -l` → **0** (was 24: 23 spikes + this file; the pattern is
written so it cannot match its own source) — and no probe defaults a tenant id:
`git grep -nE "\?\? *'(project|tenant|serviceaccount|vpcsubnet)-e0[0-9a-z]{6,}" -- spikes/` → **0**
(was 23). The loud path was exercised, not assumed: with `NEBIUS_PROJECT_ID=` empty,
`requireProjectId()` prints `NEBIUS_PROJECT_ID is required — no default is committed (R-18/R-23). …` and
exits **1**, while with the local `.env` present the same import resolves all four ids. R-23's rule replaces
R-18's path-scoped acceptance (widened above), which is the actual fix for the recurring shape this file
keeps finding: a grep that checks where the author looked is not a rule about the value.

**Not changed**: `ISSUES.md`'s *measurement* ids (`statickey-e00rgp93kahkm10hs2`, …) and
`tests/…/instance-minimal-online.test.ts`'s `project-e00public-images` — the first are recorded probe
readings (deleted resources, quoted as evidence), the second is a synthetic fixture. Neither is a default a
probe silently falls back to, which is the shape this entry is about.

**Files**: 23 of the 35 tracked files under `spikes/` (one line each) + `ISSUES.md:797` (in R-18's own
*Evidence* line, which quotes the literal while the entry's prose promises it does not)

**Evidence**: R-18 fixed the nine `tests/**` occurrences and its acceptance was
`grep -rn "project-e00eq" tests/ → 0` — a scope, not a rule. The literal that was the subject of the
report therefore survives in 24 tracked places, all of it in the same public repository. Found while
writing R-21's probe, which needed the same constant.

**Why it bites**: the value is the local `.env` project id — not a credential, exactly as R-18 assessed
it — but the fix that was accepted for it did not remove it, and an acceptance criterion expressed as
a path prefix will keep not removing things. That is the recurring shape in this file: a fix verified
only where it was looked for.

**Fix**: the shape is already written down — `spikes/static-key-parent-probe.ts` reads
`NEBIUS_PROJECT_ID` from the environment and **exits with an error when it is unset**, committing no
default. Apply it to the other 23 (or hoist one shared `requireProjectId()` into a spike helper), and
drop the literal from `ISSUES.md:797` in favour of `NEBIUS_PROJECT_ID` (the sentence does not need the
value to make its point). **Widen R-18's acceptance to the repository** — `git grep -c <literal>` → 0 —
since a path-scoped grep is what let this through.

**Acceptance**: `git grep -rn "project-e00eq" | wc -l` → **0** across the whole tracked tree, and the
spikes still run (each fails loudly with "NEBIUS_PROJECT_ID is required" when it is not set, rather
than silently probing `project-1`). The literal stays in git history either way; the point is to stop
adding it, and to make the run fail loudly instead of reaching for a committed default.

### R-24 — A newline (or `=`) in an env **key** is silently misparsed · `DONE (2026-09-27)`

**Fixed**: the predicate and its error moved to a new pure module,
`modules/resources/compute/v1/hosted-env.ts` — `invalidHostedEnvKeys()` (the three structural characters),
`assertHostedEnvKeys()` and the tagged `InvalidHostedEnvKey { keys, message }`. It imports nothing but
`effect/Schema` + `effect/Effect`, because the D8 guard forbids a static import of `hosted.ts` from
`instance.ts` (rolldown/vite + the gRPC api-clients would land in every runtime bundle) — so neither side
owns it, and both import it.

Three call sites, one predicate — the key sources differ, so all three are needed:

1. **`diff`, after `AlchemyDiff.isResolved`** (plan-time; an `env` *value* may legitimately be an `Output`,
   while the *keys* are always literal strings).
2. **The top of `reconcile`**, before props validation and before the `ComputeGrpcService` yield — so a
   deploy fails before this resource's first API call and names the key rather than the API's silence.
3. **`uploadHostedArtifacts`** — the compose-time backstop on the final map, which is the *only* place a
   **binding-supplied** key exists (`hostedEnv` merges `binding.data.env` there, and nothing reaches the
   writer without passing through it). `resolveHostedRuntime`'s error union gained `InvalidHostedEnvKey`
   for it.

**Two places it deliberately does NOT fire, with the reason recorded**:

- **`transformProps`**, even though it is the only hook that runs at *plan* time for a greenfield resource
  (and the one that declares the hosted identity's sibling bucket/key/permit). Alchemy evaluates
  `transformProps` for **every** command that builds the graph — `alchemy destroy` included — so a props
  failure there would make a stack with a bad env key *undestroyable*: the same "never block the delete"
  doctrine R-02 and R-19 follow (a blocked delete leaks the parents).
- **`read`** (the greenfield adoption probe, which is what lets `alchemy plan` fail fast for the *boot-disk*
  validators). `Factory.makeCrudRead`'s `validate` hook is typed
  `Effect.Effect<unknown, PropsValidationError, unknown>`; raising `InvalidHostedEnvKey` through it means
  widening that channel for all 40 resources, which does not belong in an S-sized fix. The honest residual:
  a **first** `alchemy plan` of a hosted instance does not reject the key; the deploy does, in `reconcile`,
  before this resource calls the API. This is the same documented gap `assertHostedEntryIsRunnable` carries
  (alchemy calls `diff` only for resources that already have state).

**Acceptance (run)**: 8 new tests, and the four required shapes are among them — the predicate refusing
`\n`, `\r` and `=`; the **negative control** that `MY.KEY`/`MY-KEY`/`MY_KEY` are
accepted (so this stays three impossible characters, not an env-name charset); `diff` propagating the
**tagged** error with `keys` equal to the offending key for both `{'KE\nY': 'v'}` and `{'A=B': 'v'}`;
`reconcile` refusing before any API call (asserted with **no layers provided**, so a guard that drifted
past the `ComputeGrpcService` yield would fail the test instead of passing vacuously); and the compose-time
backstop rejecting a key only a binding could inject, through `hostedEnv` + `uploadHostedArtifacts` (the
check precedes `makeS3Client`, so no S3 request is made). An ordinary env change still plans as
`{ action: 'update', stables: ['id', 'parentId', 'name'] }` — the guard is not a blanket rejection.
`bun run check` clean · `bun test` **1687 pass / 75 skip / 0 fail**.

**File**: `modules/resources/compute/v1/hosted.ts` (`quoteEnvValue`, `renderEnvFile`) — the **key** side,
which `quoteEnvValue` never touched (it quotes values only)

**Evidence**: found while fixing R-19. systemd's parser reads a key until the first `=`, and ends the
assignment at a newline, so `renderEnvFile({ 'KE\nY': 'v' })` emits two lines that parse as **two
assignments**, and `{ 'A=B': 'v' }` emits `A=B='v'`, which parses as key `A` with the value `B='v'` — the
value the user set is not the value the process receives, with nothing in the deploy output saying so.
(The same is true of the pre-R-19 code: the removed `.replaceAll(/\n/g, '\\n')` never applied to keys, so
this is pre-existing rather than a regression from that fix.) `env` is `Record<string, string>` on the
hosted props, and keys also arrive from bindings, so a template-generated key can carry either character.

**Why it bites**: it is the same class as R-21 and R-22 — a silent, unmeasured misbehaviour. A hosted
program with a `\n`-bearing key gets an environment variable named `KE` and another named `Y`, and the
deploy reports success.

**Fix**: reject keys containing `\n`, `\r` or `=` at plan time with a tagged error naming the key(s), the
way the value case was *intended* to be handled before measurement showed the value case needs no
guard. The machinery was prototyped for R-19 and deleted again once the value turned out to be
representable, so the shapes are known:

1. a **plan-time** guard raised from `diff` (re-plan; call it *after* `AlchemyDiff.isResolved`, since an
   `env` value may legitimately be an `Output`) **and** from the top of `reconcile`;
2. a **compose-time backstop** in `uploadHostedArtifacts` on the final map, which is the only place a
   binding-supplied key is visible and which no call path can bypass;
3. both need a module `instance.ts` may import **statically** and `hosted.ts` can share — the D8 guard
   forbids a static import of `hosted.ts` from `instance.ts` (rolldown/vite in every runtime bundle), so
   the predicate does not belong in either. A pure `hosted-env.ts` (effect/Schema + string work) is the
   shape that worked.

**Acceptance**: a test per file — the plan-time guard rejects `{'KE\nY': 'v'}` and `{'A=B': 'v'}` with the
tagged error naming the key, `diff` propagates it (the plan-time half, via a `diff`-expecting-error
helper), and the compose-time backstop rejects a newline-bearing key that only a binding could inject;
plus a test that ordinary keys (`MY.KEY`, `MY-KEY`, `MY_KEY`) are **not** rejected — the predicate must be
the three impossible characters, not an env-name charset, or it becomes an unrelated breaking change.

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
5. **R-19 — done 2026-09-25** — and it **inverted**: the issue expected "model it correctly or reject",
   and the parser reading (systemd v255, the target image's version) showed the value is representable and
   the encoder was the bug. One line removed (`\n` escaping), two tests, no VM needed. It also spawned
   **R-24** (the key side, which genuinely cannot be represented).
6. **R-10, R-12, R-15, R-16, R-18, R-20, R-21** — incremental cleanups, safe to interleave. R-15 + R-16 are
done (2026-09-25; R-16 turned out to be two sites — an error schema in `billing/v1` had the same
miss), R-18 + R-20 are done (2026-09-25), and R-21 was found by R-01's probe (2026-09-25) and is now
done too (its measurement is `spikes/static-key-parent-probe.ts`). R-10 and R-12 remain open here.
   That session also filed **R-22** (the eight-provider cascade claim) and **R-23** (R-18's leak sweep
   reached `tests/` only).
7. **R-22 — done 2026-09-25** — nine relations measured (`spikes/parent-delete-cascade-probe.ts`): the
   IAM family **cascades** (so five comments were false), the VPC/DNS family is **refused by the API**
   (`FAILED_PRECONDITION`, naming the child), and nothing was `ORPHANED` — the one reading that would
   make a blind `list` a silent leak. No provider behaviour changed; the eight comments now carry their
   own reading and the table lives in AGENTS.md.
8. **R-23 — done 2026-09-27**; **R-24 — done 2026-09-27** — both offline and small. R-23 turned out to be
   the project id *plus* the tenant, subnet and service-account ids (23 → 27 files), one shared
   `spikes/spike-env.ts`, and two footguns the fix had to avoid: `NEBIUS_SA_ID` belongs to Alchemy's SA-key
   credentials (`AuthProvider.ts`), and `NEBIUS_TENANT_ID` is read by the nuke fan-out, so neither could
   become the probes' variable. R-24's env-key guard landed in a new pure `hosted-env.ts` with three call
   sites, and its two deliberate *non*-sites (`transformProps`, `read`) are recorded in its entry — the
   first because a props failure there would block a destroy.
9. **R-10, R-12** remain open from step 6, then **R-08** last as originally ordered.
9. **R-08** — last, because it is a large refactor over the file most likely to change for other
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
