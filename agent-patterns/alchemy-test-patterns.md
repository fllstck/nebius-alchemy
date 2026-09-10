# Alchemy Integration-Test Patterns (Scratch Stack)

> Hard-won from the Nebius IAM "NOT_FOUND on freshly-created resources"
> blocker — weeks of server-side theorizing that turned out to be a
> test-pattern bug. Read this before writing ANY alchemy integration test.

## The scratch stack re-plans on every `stack.deploy()` call — and deletes!

`Test.make(...)`'s scratch stack (via `test.provider`) **re-plans the whole
stack against its shared in-memory state on every `stack.deploy(...)` call**.
Any resource from a previous deploy that is NOT present in the new effect is
treated as "removed from the stack" and **DELETED**.

```ts
// ❌ Bad — deploy #2 DELETES the SA created by deploy #1, deploy #3 deletes
//    the membership. The "phantom SA" / "NOT_FOUND on create" is real: the
//    resource is gone because the previous deploy deleted it.
const sa = yield* stack.deploy(Nebius.iam.ServiceAccount('SA', {...}))
yield* stack.deploy(Nebius.iam.GroupMembership('GM', { memberId: sa.id }))
yield* stack.deploy(Nebius.iam.AccessKey('Key', { serviceAccountId: sa.id }))
```

Diagnosing this takes forever because:
- The create *reports success* (the plan ran) — the resource just isn't there
  moments later (the *next* deploy deleted it)
- Fresh processes/CLI checks see nothing → looks like a server-side
  consistency/phantom issue
- It looks "intermittent" because whether you observe it depends on when you
  check relative to the next deploy

## Correct pattern: staged deploys re-declaring the full resource set

```ts
// Stage 1: deploy the dependency alone so its id is concrete state.
const { sa } = yield* stack.deploy(
  Effect.gen(function* () {
    const sa = yield* Nebius.iam.ServiceAccount('SA', { description: 'x' })
    return { sa }
  }),
)

// Stage 2: RE-DECLARE the full resource set — the SA becomes a noop (NOT
// deleted) — and reference it via the in-effect resource instance (`.id`).
const { key } = yield* stack.deploy(
  Effect.gen(function* () {
    const sa = yield* Nebius.iam.ServiceAccount('SA', { description: 'x' })
    const key = yield* Nebius.iam.AccessKey('Key', { serviceAccountId: sa.id })
    return { key }
  }),
)
```

Same trap with compute networking (seen live 2026-08-12): a two-deploy test
that created SG + rules in stage 1 and the instance in stage 2 silently
DELETED the SG + rules on stage 2 (not re-declared) — the instance stayed
attached to the now-deleting SG, the SG delete hung on the ENI, and the
health probe ran to its deadline looking like a "network convergence" issue.

```ts
// ❌ Bad — deploy #2 deletes the SG + rules, the probe can never succeed.
const { sg } = yield* stack.deploy(/* SG + ingress + egress */)
yield* stack.deploy(/* instance referencing sg.id */)

// ✅ Good — the complete set in ONE deploy (or re-declare SG + rules in
//    stage 2 exactly as stage 1 declared them — what the hosted-instance e2e
//    does: tests/resources/compute/v1/hosted-instance.integration.test.ts).
const { instance } = yield* stack.deploy(
  Effect.gen(function* () {
    const sg = yield* Nebius.vpc.SecurityGroup('SG', { networkId })
    yield* Nebius.vpc.SecurityRule('SG-Ingress', { parentId: sg.id, ... })
    yield* Nebius.vpc.SecurityRule('SG-Egress', { parentId: sg.id, ... })
    const instance = yield* Nebius.compute.Instance('Instance', {
      networkInterfaces: [{ subnetId, securityGroups: [{ id: sg.id }], ... }],
      ...
    })
    return { instance }
  }),
)
```

Rules that fall out of this:

1. **Every deploy's effect must contain the complete desired resource set.**
   Partial re-deploys delete the rest.
2. **Deploy precreate-dependent resources in their own earlier deploy.**
   A provider's `precreate` runs BEFORE ref resolution — alchemy passes raw
   props (unresolved refs) to precreate; `waitForDeps` + `Output.evaluate`
   happen only before `reconcile`. So a resource whose `precreate` needs
   another resource's id (e.g. an access key needs its service account) can
   NEVER be created in the same deploy as that resource — the dependency must
   already exist (deploy it first, or it must already be in state).

   **The robust fix for providers**: create in `reconcile`, not `precreate`.
   Reconcile runs after `waitForDeps` + `Output.evaluate`, so refs in the
   props are RESOLVED — a resource declared in the same deploy as its
   dependency just works (`reconcile` creates when `output` is undefined;
   observe/update otherwise). The one-time-secret capture works identically
   in reconcile. (Applied to `iam.v2.AccessKey` — this is what makes the
   binding `hostIdentity` chain — SA + group + membership + key — deployable
   in a single effect.)
3. **Reference dependencies via the in-effect resource instance** (`sa.id`),
   not a plain string copied from a previous deploy's output. The ref
   declares the dependency edge in the plan, which the destroy phase uses to
   order deletes (children before parents).

## Deletes must be idempotent (NOT_FOUND = already gone = success)

Nebius cascades deletes server-side: deleting a service account removes its
group memberships and access keys. If the destroy phase deletes the SA before
(or concurrently with) its children — which happens when the dependency edges
were persisted before the children existed — the children's deletes return
NOT_FOUND. Treat it as success:

```ts
// In makeCrudDelete (or any provider delete): NOT_FOUND means the resource
// is already gone (e.g. cascaded away) — not an error.
yield* config.deleteById(svc, output.id).pipe(
  Effect.catchIf(
    (e): e is GrpcError => e instanceof GrpcError && e.code === 5,
    () => Effect.void,
  ),
)
```

This is the standard IaC contract (Terraform/Pulumi treat 404-on-delete as
success) and makes destroy idempotent across runs.

## Mock-first runtime tests, then a gated real-infra e2e (bindings)

For HTTP runtime clients (bindings), split the test surface:

1. **Default `bun test` — local mock server** (`tests/helpers/openai-mock.ts`,
   `Bun.serve`): full request/response, auth headers, error statuses, streaming
   (scripted SSE frames) — zero cloud, zero cost. This covers the runtime
   client + SSE parser thoroughly.
2. **Impl runtime side**: set `globalThis.__ALCHEMY_RUNTIME__ = true` (the
   bundler's fold) + provide `WorkerEnvironment` + a mocked `Self` host — the
   real layer runs its runtime branch without the deploy-time branch (which
   needs a real resource's attrs).
3. **SLOW_TESTS-gated real-infra e2e** (`bindings.e2e.integration.test.ts`):
   deploy a real resource (cheap combo — nginx on cpu-d3 for the endpoint)
   and run the REAL layer with a mocked host against real attrs. Assert the
   injected env carries the expected RESOLVED values (e.g. the managed https
   URL, not raw `IP:port`) and make a real runtime call (nginx 404 →
   `EndpointNotFound` proves reachability + error mapping).

**The mock cannot catch deploy-time failure modes** — the real-infra e2e
caught, in order: the plan-phase evaluation trap (O1), the wire-shape
`ScriptStartupError` (O7), and the raw-`IP:port` URL bug. Keep the gated e2e
as the regression gate even after the mocks pass.

## Diagnostic shortcut

If integration-test failures look like server-side phantom resources or
"NOT_FOUND on just-created resources", check the deploy **plan logs first**
(`Plan: N to create, M to delete`) — a `delete` appearing in a deploy plan
that shouldn't delete anything is the smoking gun. The failure is almost
always the test's deploy pattern, not the backend.

## Diagnostic: RUNNING instance, empty serial console, all ports SYN-dropped

When an instance is RUNNING but nothing is ever reachable and the serial
console is empty, bisect in this order (all three seen live 2026-08-12):

1. **Boot image** — `disk get <id>` and check `status.source_image_id`. A
   missing source image means a BLANK boot disk: no OS boots, no serial
   output, no cloud-init, no listener — ports are dropped because NOTHING is
   listening, not because the network is broken. (CLI-created instances show
   the image; blank-disk ones don't.)
2. **SG rules** — `security-rule list --parent-id <sg>`: an empty list means
   default-deny drops everything. A zero-rule SG on a RUNNING instance is
   usually a killed test that created the SG but never got to the rules.
3. **Network age** — freshly-created networks can take 10-40+ min to
   converge public-IP (1:1 NAT) routing; reuse a stable converged subnet for
   tests (`NEBIUS_TEST_SUBNET_ID`).

For an apples-to-apples baseline against a CLI smoke test, mirror it through
the provider with the same spec (SG + rules + instance in ONE deploy, dynamic
public IP, marker cloud-init) — `tests/resources/compute/v1/instance-minimal-online.test.ts`
(provider path came online in 91s).

## Never write test artifacts into shared `/tmp`

Bundling tests (e.g. `Hosted.bundleProgram(...)`) produce a real bundle and
must write it somewhere. Writing it straight into `/tmp` is a trap observed
live in `tests/resources/compute/v1/hosted-boot.test.ts`:

```ts
// ❌ WRONG — shared, world-readable, fixed names, never cleaned up
const entryPath = '/tmp/hosted-boot-entry.mjs'
await Bun.write(entryPath, entry.content)
for (const chunk of files.slice(1)) {
  await Bun.write(`/tmp/${chunk.path}`, chunk.content)
}
```

Three distinct problems, all of which showed up:

1. **Shared namespace.** `/tmp` (→ `/private/tmp` on macOS) is `drwxrwxrwt`, so
   any local user or process can read the bundled code. Here that bundle
   contained the *entire* Nebius provider plus its auth/IAM clients.
2. **No cleanup.** The test kills the spawned process in `finally` but never
   deletes the files, so each run leaves ~5 MB behind — and it regenerates on
   every `bun test`. Cleaning `/tmp` by hand is pointless; the next run
   recreates it.
3. **Fixed filenames.** Concurrent or repeated runs collide and overwrite each
   other's chunks.

Use a per-run private directory and remove it:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'nebius-hosted-'))
try {
  const entryPath = join(dir, 'entry.mjs')
  await Bun.write(entryPath, entry.content)
  for (const chunk of files.slice(1)) await Bun.write(join(dir, chunk.path), chunk.content)
  // ...spawn and assert...
} finally {
  await rm(dir, { recursive: true, force: true })
}
```

Related: files that some tests only *reference* (never write), such as
`main: '/tmp/entry.ts'` in plan-only tests, are harmless — but prefer the
`mkdtemp` convention anyway so a future edit cannot silently start writing
there.

### Also: a shrinking test count is a load failure, not progress

When a suite reports *fewer total tests* after a dependency change (e.g. 535 →
140), files are dying at import time and contributing zero tests. Treat a drop
in the total as a hard failure signal, and check for module-resolution errors
before reading individual failures. See `effect-versioning.md` for the
version-drift cause this most often has.

## Post-destroy leak checks must tolerate ASYNC deletion

Nebius deletes are **asynchronous and soft**. The delete RPC returns as soon as
the request is accepted, but the resource stays visible in `list` — in a
deletion-pending state — for minutes afterwards, until the platform reaps it.

Observed live (2026-09-10, `eu-north1`):

| | |
| --- | --- |
| `Nebius.storage.v1.Bucket` delete returns | **149 ms** |
| bucket then sits in `state: SCHEDULED_FOR_DELETION` | **~6 minutes** |
| then | gone |

So a leak check written as "is it still listed?" **races the reap** and fails
spuriously — reporting a leak that never existed and leaving nothing behind.
Three storage tests failed on exactly this before it was understood.

```ts
// ❌ races the platform's async reap
const leaked = buckets.filter((b) => b.metadata?.name?.startsWith(prefix))

// ✅ only a LIVE resource is a leak
const leaked = buckets.filter(
  (b) =>
    b.metadata?.name?.startsWith(prefix) === true &&
    b.status?.state !== BucketStatus_State.SCHEDULED_FOR_DELETION &&
    b.status?.deletedAt == null,
)
```

Count both signals: `state` moves to `SCHEDULED_FOR_DELETION`, and `deletedAt`
carries the soft-delete timestamp (it resets to null if the resource is
undeleted). Prefer a shared helper (`tests/helpers/leaks.ts`) over copy-pasted
predicates, and include the observed `state` in the failure message so the next
reader can tell a real leak from a pending one.

**Rule of thumb:** "the destroy call returned" means *accepted*, not *gone*.
Verify against a state field, not against list membership alone.

## Mock hosts need their discriminator fields

When mocking a binding host, the `Type` field is load-bearing — **not**
decoration:

```ts
// ❌ BindHost.isCloudflareWorkerHost returns false
//    → BindHost.runtimeEnv silently falls back to process.env
//    → confusing "Missing … env bindings. Did the deploy-time wiring run?"
const mockHost = { LogicalId: 'MockHost', bind } as unknown as Worker

// ✅ matches how the real resource is recognised
const mockHost = { Type: 'Cloudflare.Worker', LogicalId: 'MockHost', bind } as unknown as Worker
```

A missing discriminator produces an error that points at production wiring, so
it sends you hunting through the implementation for a bug that is in the test.
Check the discriminating predicate (`isCloudflareWorkerHost`, etc.) before
trusting an "env not wired" failure.

## Related

- `effect-fn.md`, `effect-schema.md`, `effect-services.md` — Effect patterns
  used inside the providers
- `tests/resources/storage/v1/bindings.integration.test.ts` — canonical
  example of the staged pattern (SA → editors-group membership → access key,
  with safeDestroy)
