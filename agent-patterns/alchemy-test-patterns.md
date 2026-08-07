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

## Related

- `effect-fn.md`, `effect-schema.md`, `effect-services.md` — Effect patterns
  used inside the providers
- `tests/resources/storage/v1/bindings.integration.test.ts` — canonical
  example of the staged pattern (SA → editors-group membership → access key,
  with safeDestroy)
