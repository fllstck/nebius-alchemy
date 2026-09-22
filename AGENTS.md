# Nebius AI Cloud Providers for Alchemy V2

## 1. Critical Rules

These rules are hard requirements. Violations must be corrected immediately.

### Effect V4 & Alchemy V2

- **MUST** use Effect V4 and Alchemy V2 (`alchemy@next`)
- **MUST** use `Effect.fn("name")(function*() { ... })` for top-level functions returning Effect — do NOT create functions that return `Effect.gen(...)`
- **MUST** use `Effect.fn.Return<A, E, R>` for the return type annotation on generators inside `Effect.fn`
- **MUST** use `Schema.TaggedError` for all custom errors — never plain `Error` subclasses (renamed from `TaggedErrorClass` in effect 4.0.0-rc.112; the old name no longer exists)
- **MUST** use `Schema.Class` for domain models (gives both TypeScript type and runtime validator)
- **MUST** use `Context.Service` for service definitions
- **MUST** validate untrusted data with Schema — never use predicates or manual parsing

### No `any` (avoid if possible)

- The `any` type SHOULD be avoided
- Encapsulate `any` casts inside helper functions with typed generics at the call site
- The `grpcClient.call()` and `callMethod<T>()` patterns are approved exceptions — they hide `any` internally

### Resource provider patterns

- **MUST** use `*.fromPartial()` to construct protobuf request objects — never plain objects
- **MUST** use `SpecType.fromJSON()` instead of `fromPartial()` for specs with enum fields
- **MUST** always provide a non-empty name in metadata, auto-generated if user didn't specify one. Use Alchemy's createPhysicalName.
- **MUST** compare protobuf specs/resources with `specDeepEqual` from `modules/resources/utilities.ts` —
  never `AlchemyDiff.deepEqual` directly. `deepEqual` canonicalizes **non-plain objects
  (class instances) to `undefined`** by design (walking Effect/SDK objects is unsafe), and
  `long`'s `Long` is one, so **every int64 compares equal to every other**:
  `deepEqual(Long.fromNumber(2), Long.fromNumber(8)) === true` (verified). Any spec
  comparison is therefore blind to exactly the fields users change most — disk and
  filesystem sizes, quota limits, key rotation periods — and nested Longs (e.g. inside a
  `google.protobuf.Duration`, or `AttachedDiskSpec.managedDisk.spec`) are invisible while
  their siblings still compare. `specDeepEqual` normalizes Longs to their decimal string
  first; tests pin both behaviours in `tests/resources/utilities.test.ts`.
  **Enforced mechanically**: `nebius/no-alchemy-deepequal` (`bun run lint`, in
  `tools/oxlint-nebius-plugin`) fails on any `deepEqual` reached from an `alchemy/Diff`
  import under `modules/resources/**`. The only exemptions are `utilities.ts` (the
  workaround itself) and `tests/**` (where the framework trap is pinned by calling the real
  helper).

  **Corollary — switching to `specDeepEqual` is not always enough.** `deepEqual` also
  reports a live `Long` as equal to `undefined`, so comparing an **optional** prop against a
  **non-optional** wire field is only safe when the news side is present:

  ```ts
  // ✅ compared only when the user actually pinned it
  (news.ttl !== undefined && !ResourceUtils.specDeepEqual(record.spec.ttl, desired.ttl))
  ```

  An omitted optional prop encodes as the field's zero value, which the API replaces with its
  own default and echoes back — comparing that echo fires drift on **every** reconcile and
  the value never converges (the same hazard the drift lists dodge with
  `news.<optional> !== undefined &&`).

### Convergence — every prop must be planned, reconciled, or declared

A provider only applies a change if one of two places looks at the field:

1. **`diff`** — decides `replace` vs in-place. (The framework picks up the rest: Plan.ts
   turns *any* props change a diff ignores into `action: "update"` via
   `diff ?? { action: havePropsChanged(olds, news) ? "update" : "noop" }`.)
2. **`reconcile`'s drift list** — what an in-place update actually writes.

So a prop in **neither** plans an update that writes nothing, and the change is silently
lost (it only lands later if some unrelated change happens to send a full desired spec —
which every update does). That is how `gpuCluster` behaved, and how
`instance.{recoveryPolicy, hostname}`, `disk.{sourceImageId, sourceImageFamily,
 sourceSnapshotId, diskEncryption}`, `image.{cpuArchitecture, recommendedPlatforms}`,
`security-rule.description` and `static-key.{description, expiresAt}` each behaved before
the 2026-09-19 sweep. The same silent loss happens *inside* a drift list when the comparison
itself is blind: `record.ttl` and `zone.soaSpec.negativeTtl` were compared with
`AlchemyDiff.deepEqual`, so their int64s compared equal and both branches were dead code until
2026-09-21.

Every user-facing prop **MUST** be one of:

- in the `diff` comparison list (with the ordering rule above), or
- in `reconcile`'s drift list (then a change converges in place) — prefer this whenever the
  field was already part of `desired`: adding it to the list changes *when* an update fires,
  not the payload, so the API (not us) decides whether it is legal; or
- planned as a **replace** when the API cannot change it (`preemptible`, `gpuCluster`,
  a disk's content source, `description`/`expiresAt` on the issue-only `StaticKey`,
  `dns/v1/record.relativeName` — the physical name is derived from it and a Nebius name is
  immutable, so an in-place write would contradict `metadata.name`, or worse be ignored and drift
  forever); the plan makes it visible instead of silent; or
- **declared**: documented as create-time-only, with a comment saying why, **plus the fields that
  only ever travel on a request** (`invitation.{noSend,expiresInSeconds}` are
  `CreateInvitationInput` fields). `labels` is the one fleet-wide example: no update path sends
  labels, so a labels-only change is a no-op until some other change rewrites the resource.
  *Decision, not impossibility*: `Update*Request.metadata` is the shared `ResourceMetadata`, which
  does carry `labels`, so converging them is a code change (merge internal + user labels into every
  update's metadata, 30+ sites) that also changes behaviour — a label removed from config would be
  deleted in the cloud. Parked in TASKS.md; a `declared` entry must always say which of the two it
  is, or the table rots into "everything is declared"; or
- a **selector of a sibling field**: a props-only field that has *no* wire field, because the
  API derives it from which sibling message is present and reports it back through `status`.
  `security-rule.direction` is the one such prop — `SecurityRuleSpec` has no `direction` at
  all (the API infers INGRESS/EGRESS from `ingress` vs `egress` and returns it in
  `status.direction`). It converges **through that sibling**, so it MUST NOT appear in the
  drift list; pin the sibling's plan and the status echo instead
  (`tests/resources/vpc/v1/unit.test.ts`). Because a rule with *neither* block cannot express its
  direction at all, the props schema **requires the block the direction selects** — so the
  unrepresentable state is a plan-time error rather than a silent no-op. A props-vs-provider text
  audit flags the prop as "never compared" — a false positive, like the ones recorded in
  TASKS.md §"What could not be automated".

**Enforced by the convergence sweep** — `tests/convergence.test.ts` (the tables) and
`tests/convergence-coverage.test.ts`, with the harness in `tests/helpers/convergence.ts`.
There is **one mechanism**: a table per resource that

- probes **every** prop — a change must be planned by `diff` or written by a mocked `reconcile`,
  with `planned(patch, expect)` used wherever the plan *shape* is the contract
  (`{ action: 'replace' }` = create-first vs `…deleteFirst: true` = delete-first);
- carries an anti-loop row for optional props (`omits`: omitting one must write nothing) and a
  `declared` map with a **reason per non-converging prop** — the escape hatch that keeps the
  table from rotting into "everything is declared";
- carries **two baseline rows**: reconcile-noop, *and* **diff-noop against a structurally identical
  `olds`** (a JSON clone of the baseline, which is what the state store hands `diff` on a
  re-apply). The second is not redundant: the first never diffs, so it cannot see a provider that
  compares an **object-valued prop by reference** (`news.source !== olds.source`) — which is true
  on every apply, plans a replace on every deploy, and fails as `ALREADY_EXISTS` in the
  create-first replacement while the old generation still holds the identity
  (`storage/v1/transfer`, found live 2026-09-22, and the only one of the 38 resources it caught).

The coverage test discovers all 38 providers from `modules/` and fails when one has no table, so
a new resource cannot slip in unclassified; the table's own completeness check fails on a new
prop until someone classifies it. Two earlier mechanisms are **retired**, not layered on top:
*by construction* (asserting a whole-spec comparison pattern in the source — it proved that a
comparison existed, not that every prop reached `desired`) and the hand-written prop-set guards
of the resources with no update RPC (a table row proves behaviour; a name list proves nothing).
Tabulating the by-construction resources paid immediately: it found `transfer.stopCondition`
reaching neither `desired` nor the wire (the proto models it as three flat fields), an identity
prop that was never compared, and an immutable field that was written in place.

The sweep also caught four providers comparing an *optional* prop against the platform's own
default — `subnet.routeTableId`, `disk.{sizeGibibytes,blockSizeBytes}`, `image.cpuArchitecture`,
`filesystem.blockSizeBytes` — each of which re-issued an update on **every** reconcile. The
`news.<field> !== undefined` guard is therefore part of the rule, not a style choice.

**The mock can only ever say "the API echoes what I sent" — it must be told otherwise.** Every
`live` fixture in the sweep is built *from the same props the provider sends*, so the sweep is
blind to a whole class that live probes keep finding: the API answers something the props never
contained. The three shapes seen so far, each with its own treatment (all found 2026-09-22):

- **Materialized defaults**, i.e. fields the API fills in and echoes back, which `desired` will
  never carry: the pools of `vpc/v1/{network,subnet}` come back as `{pools: [],
  useNetworkPools: true}` (the network later gets real `vpcpool-` ids assigned into its spec), and
  `storage/v1/transfer` gets `limiters: {}` plus `interIterationInterval: 900s`. Comparing the echo
  against the omitted prop writes an update on every reconcile — the tell is
  `metadata.resourceVersion` = 2 after a deploy that should have written once. Fix by guarding on
  the news side (`news.<field> !== undefined && …`) or by mirroring the live value into `desired`
  (as `filesystem.blockSizeBytes` does). Encode the echo in the table's `live` fixture and add the
  prop to `omits`, or the pinned row is vacuous.
- **Write-only fields never echoed**: `transfer`'s `secretAccessKey` comes back as `""`, so a
  whole-spec comparison against `desired` (which holds the real secret) can never match. Strip
  credentials from both sides before comparing (`withoutCredentials` in `storage/v1/transfer`,
  noting it must return a *structural* clone so `Long`s are still `Long`s for `specDeepEqual`).
  Nothing is lost by ignoring them: a change inside `source`/`destination` — a rotated key
  included — is planned as a replace by `diff` and never reaches the update path.
- **Effective value only in `status`**: a filesystem created without `blockSizeBytes` answers `0`
  in `spec` and `4096` in `status`. Mirror whichever field the API actually answers with, and read
  attributes knowing that `toFriendlyAttributes` merges `spec.toJSON`/`status.toJSON` — status
  wins, and int64s arrive as strings (`FilesystemAttributes.blockSizeBytes` is typed `Finite` but
  is `"4096"`; `RecordAttributes.ttl` models that correctly as a string).

**A hand-written `delete` MUST treat `NOT_FOUND` as success**, exactly as `makeCrudDelete` does.
This is not cosmetic: when a create fails, the leftover state row makes the delete fail, and the
planner then skips every dependent (`Skipping delete — blocked by failed delete of <resource>`),
leaking the parents. `storage/v1/transfer` leaked two buckets, a service account and an access key
that way (live 2026-09-22).

**A resource with no `Update` RPC MUST be tabulated prop by prop in the convergence sweep.**
That is the only shape in which the silent-no-op class can survive. With an update RPC,
`reconcile` sends the full `desired` spec, so any prop change is written and the API adjudicates
legality — a new prop is safe by construction. Without one, the `diff` is the **only**
convergence path, so a prop it ignores is lost, and a prop added later is lost silently. These
six used to carry a hand-written prop-set guard (`Object.keys(<Resource>PropsSchema.fields)
.toSorted()`); they now have sweep tables, which subsumes it — the guard could only say "the prop
list did not change", the table probes each prop for an actual *plan*: `secret-version`,
`group-membership`, `access-permit`, `static-key`, `gpu-cluster`, `group`.
`ai/v1/{endpoint,job}` need none either way: they compare everything-but-`labels`, so a new prop
already replaces (they sit in the by-construction register). **Check whether the service has an
update RPC before writing the provider** — the Terraform provider's generated
`Update is unimplemented for <service>` stubs answer that directly, and that is how
`group-membership`'s silent no-op was found.

And: **a prop that is not a wire field at all MUST be removed, not documented** — the dead
`security-rule.description` (the proto has no such field) was dropped rather than kept as a
silent no-op.

Extract the drift list into a module-level, exported function (as `instanceSpecDrifted` does)
when the reconcile body is too heavy to test through, so the convergence contract is
directly unit-testable.

### Naming — schema casing, verbatim

The generated protobuf TypeScript under `schemas/nebius/**` is the **single source of
casing truth**. Never re-case a name to satisfy a style guide.

- **MUST** spell resource type strings, namespace aliases, class names, prop/attribute
  fields and any other identifier that mirrors a schema name **exactly as the schema
  spells it** — `'Nebius.compute.v1.NVLInstanceGroup'`, `NebiusNVLInstanceGroup`,
  `Nebius.compute.NVLInstanceGroup`.
- **MUST** keep all-caps initialisms all-caps, because that is what the schema does:
  `NVLInstanceGroup`, `GB200`/`GB300`, `NVLinkSpec`, `IPAddress`/`PublicIPAddress`,
  `IPAlias`, `CORSConfiguration`/`CORSRule`, `OSInfo`, `NIDFieldSettings`, `S3*`.
  Write `NvlInstanceGroup`/`GpuClusterId`-style re-casings only where the schema itself
  is lowercase (`gpu_cluster` → `GpuCluster`, `ip_address` → `ipAddress`).
- **MUST** use the schema's own field spelling for props/attributes. `snake_case` in the
  proto is already `camelCase` in the generated schema (ts-proto does that conversion) —
  copy it as-is; do not invent synonyms or re-case.
- Coined identifiers (aggregate gRPC services, actions, bindings) PascalCase the schema
  token they derive from and preserve its acronym treatment: package `mysterybox` →
  `MysteryBoxGrpcService` (the schema spells `MysteryBox` in `EndpointSpec_MysteryBoxSecretRef`),
  `vpc` → `VpcGrpcService`, `ai` → `AiGrpcService`.
- A *deliberate reshape* is not a rename for style and is allowed — but it **MUST** be
  documented at the field: the `google.protobuf.Duration` → `…Seconds` mapping and
  `storage/v1/transfer`'s `stopCondition` union are the two existing examples.
- File names are kebab-case for multi-word resources (`route-table.ts`,
  `nvl-instance-group.ts`); the proto's own file name stays lowercase in `schemas/`.

Audit status: `modules/resources` has **0** casing deviations today (36/36 resource type
strings match their generated message names; 0 casing-only prop/spec field mismatches,
nested structs included). This rule exists to keep it that way — re-check with
`bun tools/schema-conformance.ts` (exits 1 on any deviation) and see TASKS.md
§"Casing conformance".

### Branded IDs — everywhere, inputs and outputs

An identifier that names a schema entity **MUST** be the entity's brand, never a bare
`Schema.String`.

- **MUST** brand every ID-valued prop **and** attribute, on the input and the output side
  of a resource. `nvlInstanceGroupId: Schema.optional(NVLInstanceGroupId)`,
  `sourceDiskId: Ids.DiskId`, `serviceAccountId: ServiceAccountSchema.ServiceAccountId`.
- **MUST** declare brands in **one `ids.ts` per service version**
  (`compute/v1/ids.ts`, `iam/v1/ids.ts`, `vpc/v1/ids.ts`, …) — never inline in a resource
  schema, so there is exactly one place to look. A file's own service ids import as
  `Ids`, another service's as `<Pkg>[Vn]Ids` (`IamIds`, `IamV2Ids`, `VpcIds`, `MysteryboxIds`, …).
- **MUST** add a brand for a new resource/entity **before** wiring its provider, so parent
  references never type-check as plain strings.
- A field that references a **polymorphic** entity takes its own brand — either a
  **nominal brand** when the target set is open (the permit target of
  `iam/v1/access-permit`, a KMS key that may be symmetric *or* asymmetric — `KmsKeyId`), or
  a **union of the concrete brands** when the proto closes the set (the member of
  `iam/v1/group-membership`, closed by `GroupMemberKind.Kind`). Prefer the union when it
  applies: a nominal brand over a closed set forces an `Output.map(…)` conversion at every
  call site for no extra safety.
- A caller holding a concrete brand converts explicitly at the boundary:
  `Output.map(bucket.id, (value) => AccessPermitResourceId.make(value))`.
- `Schema.brand` refinements run in `.make()` too: a field whose **empty string is a
  meaningful sentinel** (`compute/v1/instance.serviceAccountId`, where `''` means "no
  service account") **MUST** be modelled as a union with `Schema.Literal('')`, otherwise the
  realistic values (`''` from a `Config.withDefault('')`, or a real `serviceaccount-…` id)
  cannot both decode.
- A value that is **not** a Nebius resource identifier MUST NOT be branded: external
  identifiers (a federated IdP subject, an AWS-format access-key SID such as
  `awsAccessKeyId`/the S3 `accessKeyId` credential — *not* the `AccessKey` resource id, a
  CORS rule id, an OpenAI-compatible completion id), guest-side names (`deviceId`), and
  sentinels such as the `''` = auto-allocate `ipAddress.allocationId`. Leave those as
  `Schema.String` with a doc comment saying why.
- Consequence, accepted: branded props reject string literals in typed callers. Get IDs
  from resource outputs; when a literal is unavoidable (env-read ids, test fixtures), brand
  it explicitly at that boundary — `.make(value)` for a literal, an explicit empty arm for a
  possibly-empty one. The package re-exports the brands as **values**, so
  `Nebius.iam.ServiceAccountId.make(…)` works for consumers.

Audit status: casing and branding conformance are both re-checkable with
`bun tools/schema-conformance.ts` (exit 1 on a casing deviation; it also prints the
bare-string ID candidates). 14 remain, and every one of them is an approved exception from
the list above — the full classification lives in TASKS.md §"ID1 — Branded IDs".

### Replace ordering — create-first vs delete-first

Alchemy's default replace is **create-first** (new generation created, then Phase-2 GC
reclaims the old one). That is safe only while the two generations can coexist, so **every
`{ action: 'replace' }` for a spec-only change MUST go through a `Factory` helper** — never
return a bare one. A resource's identity is `(parent, physical name)`, which gives exactly
three cases:

| change | action | why |
| `name` changed | create-first (`nameChangeRequiresReplace`) | different physical name |
| parent changed | create-first | different parent — Nebius uniqueness is per-parent |
| **spec-only**, name is `props.name ?? createPhysicalName(…)` | `Factory.replaceKeepingName(news)` | generated name is minted fresh per generation (the `InstanceId` is re-minted on replace) → create-first; a **pinned** `name` is reused → `deleteFirst` |
| **spec-only**, name derived from the logical id (`ak-<id>`, `sk-<id>`) | `Factory.replaceSameGeneratedName()` | every generation asks for the same name → always `deleteFirst` |

`deleteFirst` deletes the old generation inside this resource's own node, i.e. **before its
dependents' nodes run** (apply order is dependency-first), so old dependents still hold the
old id at that instant. That is fine while the API tolerates the dangling reference for that
window; a parent whose API forbids it (a group that must be empty) needs a delete pre-check
with an actionable error instead — providers **cannot** see their dependents (the lifecycle
input has no `downstream`), so that check has to come from the API.

**Invariant: every prop holding a foreign resource id MUST participate in `diff`.** The
framework orders teardown, but it only *cascades* through what providers report: if a
provider ignores such a prop, a parent's replacement changes the id, the dependent is never
planned, and GC deletes the parent underneath it — silently. `gpuCluster` on the Instance
was exactly this hole.

### Vendored repos

- **Read-only**: Do NOT edit files under `repos/`
- **Reference only**: Do NOT import from vendored repos in production code
- **Prefer vendored source**: When unsure about Effect, Alchemy, or the Nebius API, check in `/repos` first

### Websites

- https://v2.alchemy.run/llms.txt for Alchemy v2 docs for implementing custom resources/providers/auth
- https://effect.solutions/ for additional Effect patterns and best practices

### Testing

- Always write tests for implemented resources
- Always run `bun run check` to type-check and lint after code changes
- Do NOT test `AuthProvider` layers with `Effect.provide` + `Layer.mergeAll` — use `AlchemyTestUtilities.make()` instead

### Namespace hierarchy examples

```ts
import * as Nebius from '@fllstck/nebius-alchemy'
Nebius.storage.v1.Bucket
Nebius.iam.v2.Project
Nebius.vpc.v1.Network
```

## Vendored Repositories

The Effect V4 monorepo is vendored at **`repos/effect/`** (read-only reference).

> ⚠️ **The vendored copy is STALE.** It is `effect@4.0.0-beta.102`; this project
> compiles against **`4.0.0-rc.117`**. It still teaches `Schema.TaggedErrorClass`,
> which was **removed** in rc.112 (we migrated to `Schema.TaggedError` — see
> `agent-patterns/effect-schema.md`). Copying API usage out of it will
> reintroduce exactly that bug. Use it for **concepts** (modelling, services,
> layers, streams), never as the API reference.

**Authoritative sources, in precedence order:**

1. **`node_modules/effect/dist/*.d.ts`** and **`node_modules/alchemy/src/`** — the
   versions this project actually compiles and runs against, so they are current
   by definition. Start here for ANY API-surface question (does `X` still exist,
   what are the argument types). `node_modules` is NOT "possibly outdated" here;
   it is the pinned truth.
2. **`repos/effect/LLMS.md`** — Effect's own best-practice guide, still excellent
   for *how to structure* Effect code. Verify every API it names against (1).
3. **`agent-patterns/*.md`** — this repo's curated summaries, kept in sync with
   the pinned versions. Prefer these over (2) for anything version-sensitive.

The Alchemy V2 monorepo is **not** vendored. Read it from
`node_modules/alchemy/src/` — that is the installed version this project actually
compiles and runs against, so it is authoritative for `AuthProvider`,
`Interaction`, `Provider`, `Bundle`, `Tags`, and everything else. Prefer it over
web search and over the published docs (which track `latest`, not the version
pinned here). `agent-patterns/alchemy-*.md` are the curated summaries of it.

### Pattern reference files

The `agent-patterns/` directory contains concise summaries extracted from the vendored source:

| File                                | Contents                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| `agent-patterns/effect-fn.md`       | Effect.fn vs Effect.gen, Effect.fn.Return, combinator attachment |
| `agent-patterns/effect-schema.md`   | Schema.Class, Schema.TaggedError, decoding/encoding              |
| `agent-patterns/effect-services.md` | Context.Service, Layer.effect, Layer composition                 |
| `agent-patterns/effect-versioning.md` | Effect prerelease versioning: the caret-range drift trap that silently upgrades `rc.N` → `rc.N+1`, and how to pin/hold `@effect/*` packages |
| `agent-patterns/effect-debugging.md` | Finding *what actually ran* an effect when stack traces are flattened: instrument decision points, bisect the layer graph by providing subsets, probe library semantics with a 5-line script, and why `Layer.orDie` hides typed failures from `catchTag` |
| `agent-patterns/release-and-publish.md` | Releasing: `conventional-changelog -s` prepends (duplicate sections), commit footers leaking verbatim into published notes, gitignored-but-required `schemas/`, dry-run↔registry shasum equality, verifying the *registry* copy as a consumer, and the "did it publish?" diagnostic ladder |
| `agent-patterns/alchemy-auth-provider.md` | The `AuthProviderImpl` contract: `configSchema`, lazy per-method `Interaction` resolution, error-channel limits, `CredentialsStore` schemas, `ProfileStore`/`resolveProviderConfig` |
| `agent-patterns/alchemy-test-patterns.md` | Alchemy scratch-stack deploy semantics (partial re-deploys DELETE prior resources), staged-deploy pattern, precreate-vs-ref-resolution timing, idempotent deletes, temp-dir hygiene |
| `agent-patterns/alchemy-bindings.md`      | Binding impl patterns: Output passthrough (never inline-resolve), reconcile-create vs precreate, Effect-native Worker entry structure (dev vs remote `main`), shared-env once-per-host dedupe, Effect HTTP gotchas, Node `.ts`-extension imports |
| `agent-patterns/alchemy-effectful.md`     | Effectful-compute patterns: the `Platform`/Effectful Constructor shape (constructor + provider split), `main` as the low-level↔hosted toggle, RuntimeContext (`run`/`serve`/`exports.program`), bundle→ship→reconcile, phase split (`__ALCHEMY_RUNTIME__` + `ALCHEMY_PHASE`), and applying it to the Nebius Instance (cloud-init + S3 assets + service accounts) |

## Quick Reference Commands

```bash
# Type checking
bun run typecheck          # tsc --noEmit

# Linting
bun run lint               # oxlint modules/ tests/ examples/

# Both
bun run check              # typecheck + lint

# Testing
bun test                   # Unit + integration tests

# Schema generation
bun run generate:schemas   # buf generate (download protobuf and convert to TypeScript)

# Deployment
bun alchemy plan <stack>
bun alchemy deploy <stack> --yes
bun alchemy destroy <stack> --yes

# Nebius CLI
nebius iam project list
nebius iam service-account list
nebius storage bucket list
```

## Implementation Guidelines

### Protobuf Serialization

- **Always use `*.fromPartial()`** to construct request objects — never plain objects
- **Always use `SpecType.fromJSON()`** for specs with enum fields (strings → int32)
- Always provide a non-empty name in metadata: `news.name ?? (yield* createPhysicalName(...))`
- Check generated Get request interfaces — if they have fields beyond `id`, provide a custom `getRequest` using `fromPartial`

### Resource Lifecycle Details

- `precreate` runs BEFORE reconcile for greenfield deployments; its output becomes the initial `output` for reconcile
- When `precreate` is set, reconcile NEVER creates the resource — it dies with a clear error if `output` is undefined
- Ownership tagging uses `createInternalTags` / `hasAlchemyTags` / `Unowned` from `alchemy/Tags`
- Label merge order: internal tags are base, user labels override

### Testing

- Default `bun test`
- Use `AlchemyTestUtilities.make({ providers: ... as any })` for integration tests
- Use sequential `stack.deploy()` calls for quota-sensitive resources
- Not all API responses echo back provided fields — don't assert all input fields in output

### Non-standard APIs

Some Nebius APIs don't follow the standard CRUD pattern:

- **IAM StaticKey**: uses `Issue` not `Create` — token only available at creation time, must be stored in output
- **AccessPermit**: requires group parent (not project), rejects `metadata.name`
- **GroupMembership**: uses `listMembers` instead of `list`
- **QuotaAllowance**: lacks stable `id` — use `(parentId, name, region)` as identity tuple
- **ResourceAdvice**: virtual advisory resource with `id: ""` — list-only, no stable identifier
- **Storage Transfer**: `source.nebius.accessKey` is **required by the API** even though the proto
  marks it optional (without it `Create` answers a bare `3 INVALID_ARGUMENT: Invalid argument` for
  every stop condition) — the props schema requires it, so it fails at plan time instead. The
  destination/source `secretAccessKey` is never echoed (`""`), `limiters` and
  `interIterationInterval` come back as platform defaults, and `stopCondition` is three **flat**
  oneof fields (`afterOneIteration`/`afterNEmptyIterations`/`infinite`) with no `stopCondition`
  message — `fromJSON` silently dropped the prop before 2026-09-21, so the transfer ran with the
  server's default stop behaviour on create *and* update.

### Naming Conventions

- Auto-generated names via `createPhysicalName({ id, maxLength, lowercase })` from `alchemy`
- Resolution order: `props.name` > `generateName?(tag)` > `createPhysicalName(...)`
- Use for first create only — subsequent reconciles look up by `output.id`

## Tips & Patterns

### `Duration.Input` type

In Effect V4: `Duration.Input`, not `Duration.DurationInput`.

### S3 endpoint is `storage.<region>.nebius.cloud`, NOT `s3.<region>.nebius.cloud`

### S3 access keys are region-scoped

Create AccessKeys in the same project/region where you'll use them for S3.

### Bucket quota is per-region, not per-project

Always delete buckets via the Nebius CLI or gRPC API (not raw S3 API) to properly release quota.

### Displayed quota allowance values may differ from actual enforced limits

Check error messages for the actual enforced limit.

### `fromPartial` on spec with enum fields passes strings through — use `fromJSON`

```ts
// ❌ Bad — strings pass through, serialization produces NaN
CreateRequest.fromPartial({ spec: { access: 'ALLOW' } })

// ✅ Good — fromJSON converts enum strings to int32
SecurityRuleSpec.fromJSON(news.spec)
```

### `google.protobuf.Duration` from JSON: `{ seconds, nanos }` only

The generated `Duration.fromJSON` accepts **only** the message form. The
canonical protobuf JSON form — the **string** `"2592000s"`, which is what the
Nebius CLI and the API's JSON renderings emit — is **silently dropped** (the
field becomes `0`, then encodes as absent). Well-known-type JSON needs an
explicit reshape; expose a `...Seconds` number on props and map it, as
`storage/v1/transfer.interIterationIntervalSeconds` and
`kms/v1/symmetric-key.rotationPeriodSeconds` do.

Corollary: props never come straight from API/CLI JSON. SDK JSON is
**snake_case**, props are camelCase, and `Duration`/`Timestamp` well-known types
have no shared representation.

### `Effect.cachedInvalidateWithTTL` inner effect retains requirements `R`

Resolve dependencies inside the `Effect.gen` block so the cached token source has `R = never`.

### `precreate` lifecycle for dependency-breaking

Use when a resource's ID must be resolvable by child resources in the same deploy.

### `session.note()` for progress reporting

```ts
yield * session.note(`Creating Nebius.storage.v1.Bucket (${news.name})`)
```

### `deepEqual` and `diffTags` for structured comparison

```ts
import { deepEqual, isResolved } from 'alchemy/Diff'
import { diffTags } from 'alchemy/Tags'
```

### `nuke` configuration

```ts
nuke: { singleton: true },  // always-present account singleton
nuke: { skip: true },       // no delete API available
```

### Resilient list — catches GrpcError and returns `[]`

### `Effect.fn` traces feed into OpenTelemetry automatically

Every `Effect.fn("name")` creates an OTel span. Names like `"pollOperation"`, `"callWithOperation"` appear as named spans.

### Use `DateTime.formatIso` instead of `.toISOString()` for Date formatting

Imported from `#utils/common/datetime.ts` for consistency across the codebase:

```ts
import { formatTimestamp } from '#utils/common/datetime.ts'
// before: date?.toISOString() ?? ''
// after:  formatTimestamp(date)
```

Only use this for Date → string (read path). For string → Date (write path, like `new Date(spec.expiresAt)`), keep `new Date()` — DateTime requires an unnecessary roundtrip.

### `Provider.succeed` — capture deps at call time, not construction time

`Provider.succeed` accepts lifecycle functions directly (no `Effect.gen` wrapper). Each lifecycle `yield*` its own dependencies at call time. Use it instead of `Provider.effect` when services don't need to be shared across lifecycles:

```ts
// ✅ Provider.succeed — deps captured at call time
export const StaticKeyProvider = () =>
  Provider.succeed(StaticKey, {
    reconcile: Effect.fn(function* ({ news, output }) {
      const grpcClient = yield* NebiusGrpcClient // captured at call time
      const { projectId } = yield* NebiusConfig
      // ...
    }),
    delete: Effect.fn(function* ({ output }) {
      const grpcClient = yield* NebiusGrpcClient // fresh each call
      // ...
    }),
  })

// ❌ Provider.effect — adds unnecessary Effect.gen wrapper
```

### Bindings must be yielded in the **impl** argument, never the props Effect

A `Platform` resource provides `Self` around `impl` (`node_modules/alchemy/src/Platform.ts`,
`Layer.succeed(Self, instance)` before running it). The **props** Effect runs
outside that context, so `Binding.Host` resolves `undefined` there and the
binding's deploy-time branch is *silently skipped* — no IAM grant, no env
injection, and the failure only shows up at runtime as `Missing Nebius S3 env
bindings: …`. `tests/resources/compute/v1/hosted-bindings.test.ts` pins both
behaviours (impl → the instance; props → `undefined`) so this cannot regress.

```ts
// ✅ the instance is its own binding host
yield* Nebius.compute.Instance('Api', props, Effect.gen(function* () {
  yield* Nebius.storage.GetObject(bucket).pipe(Effect.provide(Nebius.storage.GetObjectHttp))
  return { fetch }
}))
// ❌ silently skips all binding wiring
yield* Nebius.compute.Instance('Api', Effect.gen(function* () {
  yield* Nebius.storage.GetObject(bucket)   // host === undefined
  return props
}))
```

A `main`-only instance (no inline impl) is *also* wrong for a hosted program:
`isExternal` is set, `bundleProgram` skips the bootstrap virtual entry, and
nothing ever runs the bundle — a VM that boots and serves nothing, silently. The
provider now **rejects it** with `HostedEntryNotWrapped` (in `reconcile`, i.e. at
the start of any `alchemy deploy` before the first API call, and in `diff`, so a
re-plan fails during planning). Pass the init Effect; if your `main` IS the
runnable entry (it starts its own HTTP server), opt in with `isExternal: true`
explicitly. Note: a greenfield `alchemy plan` cannot catch this — alchemy only
calls `diff` for resources that already have state.

### Plan-time `Config` captures reach the shipped env as **Redacted**

`Platform`'s config interceptor stores every `Config.*` lookup as
`Output.literal(Redacted.make(value))` and folds it into the resource `env` —
where it *overrides* a binding's plain value. Since the env file is plaintext on
the VM, `quoteEnvValue` unwraps all three forms a Redacted arrives in (live,
`{ _tag: 'Redacted', value }`, and the JSON **string** the state store yields).
Never `JSON.stringify` a Redacted into shipped env — the VM then receives
`NEBIUS_REGION={"_tag":"Redacted","value":"eu-north1"}`, which broke SigV4
signing in the hosted e2e.

### `hostIdentity` pins itself to the host's namespace

`modules/resources/shared/host-identity.ts` declares `<host>BindingSA/Group/
Membership/Key` under `Namespace.set(hostLogicalId)`, **absolutely**. It is
called from two places — `transformInstanceProps` (already inside
`Namespace.push(id)`) and the binding impl (root namespace) — and with an
*ambient* namespace those produced two different FQNs, i.e. two identities with
the same physical AccessKey name and an `ALREADY_EXISTS` at deploy. Keep it
absolute; do not "simplify" it to `push`.

### Ownership tagging

When implementing ownership tagging manually, import from `alchemy/Tags` and `alchemy/AdoptPolicy`:

```ts
import { createInternalTags, hasAlchemyTags } from 'alchemy/Tags'
import { Unowned } from 'alchemy/AdoptPolicy'

// Create: merge internal tags into metadata.labels
const internalLabels = yield * createInternalTags(id)
const labels = { ...internalLabels, ...userLabels }

// Read: check ownership, return Unowned if mismatch
const labels = result.metadata?.labels ?? {}
if (yield * hasAlchemyTags(logicalId, labels)) {
  return attrs
}
return Unowned(attrs)
```
