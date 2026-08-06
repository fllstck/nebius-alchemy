# Nebius AI Cloud Providers for Alchemy V2

## 1. Critical Rules

These rules are hard requirements. Violations must be corrected immediately.

### Effect V4 & Alchemy V2

- **MUST** use Effect V4 and Alchemy V2 (`alchemy@next`)
- **MUST** use `Effect.fn("name")(function*() { ... })` for top-level functions returning Effect — do NOT create functions that return `Effect.gen(...)`
- **MUST** use `Effect.fn.Return<A, E, R>` for the return type annotation on generators inside `Effect.fn`
- **MUST** use `Schema.TaggedErrorClass` for all custom errors — never plain `Error` subclasses
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

The Effect V4 monorepo is vendored at `repos/effect-smol/` for reference.

**Before writing any Effect code**, read `repos/effect-smol/LLMS.md` — it contains authoritative best practices for Effect patterns, services, errors, streams, and more. Prefer patterns from the vendored source over web search or `node_modules` (which may be outdated).

The Alchemy V2 monorepo is vendored at `repos/alchemy` for reference.

**Before writing any Alchemy code**, browse the code in `repos/alchemy` — it contains authoritative best practices for Effect patterns, services, errors, streams, and more. Prefer patterns from the vendored source over web search or `node_modules` (which may be outdated).

### Pattern reference files

The `agent-patterns/` directory contains concise summaries extracted from the vendored source:

| File                                | Contents                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| `agent-patterns/effect-fn.md`       | Effect.fn vs Effect.gen, Effect.fn.Return, combinator attachment |
| `agent-patterns/effect-schema.md`   | Schema.Class, Schema.TaggedErrorClass, decoding/encoding         |
| `agent-patterns/effect-services.md` | Context.Service, Layer.effect, Layer composition                 |
| `agent-patterns/alchemy-test-patterns.md` | Alchemy scratch-stack deploy semantics (partial re-deploys DELETE prior resources), staged-deploy pattern, precreate-vs-ref-resolution timing, idempotent deletes |
| `agent-patterns/alchemy-bindings.md`      | Binding impl patterns: Output passthrough (never inline-resolve), reconcile-create vs precreate, Effect-native Worker entry structure (dev vs remote `main`), shared-env once-per-host dedupe, Effect HTTP gotchas, Node `.ts`-extension imports |

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
