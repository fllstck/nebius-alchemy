# Alchemy Effectful-Compute Patterns (Platform / hosted runtimes)

> The effectful pattern is for ANY compute, not just serverless — Alchemy has
> it for `AWS.EC2.Instance`, `AWS.ECS.Task`, `AWS.Lambda.Function`,
> `Cloudflare.Worker`. A compute resource either acts as a **low-level
> primitive** (plain CRUD) or **bundles a long-lived Effect program** that runs
> directly on the machine. Authoritative references: `alchemy/Platform.ts`,
> `alchemy/Server/Process.ts` (shared host context), `alchemy/Bundle`
> (rolldown), and the AWS reference impl `AWS/EC2/hosted.ts` +
> `AWS/EC2/Instance.ts`. Docs: v2.alchemy.run/providers/aws/ec2/instance/
> ("Hosting Processes") and /infrastructure-as-effects/custom-runtime.

## The shape: constructor + provider, one Effect

A runtime resource splits in two. Users call the **constructor**, built on
`Platform` (exported from `alchemy` in beta.70):

```ts
export const Task: Platform<Task, TaskServices, TaskShape, TaskRuntimeContext> =
  Platform("AWS.ECS.Task", {
    createRuntimeContext: createHostRuntimeContext("AWS.ECS.Task"),
  })
```

The **provider** is an ordinary `Provider.effect` — `Platform` already ran the
user's init Effect, collected handlers, and folded them onto the resource's
props, so reconcile only has to (a) bundle + ship the code and (b) reconcile
cloud state. `Platform`'s four type params: `Resource`, `Services` (provided
to the init Effect), `MainShape` (`Main<Services>`), `RuntimeContext` (extends
`BaseRuntimeContext`).

User-facing declaration is one Effect that declares infra props **and** the
program (Effectful Constructor pattern):

```ts
const api = yield* Effect.gen(function* () {
  yield* Http.serve(HttpServerResponse.json({ ok: true }))
  return {
    main: import.meta.url,
    imageId, instanceType: "t3.small",
    subnetId, securityGroupIds: [sg.groupId],
    associatePublicIpAddress: true,
    port: 3000,
  }
}).pipe(
  Effect.provide(AWS.EC2.HttpServer),
  AWS.EC2.Instance("ApiInstance"),
)
```

Class form (`<Self>()` overload) exists too — `AWS.ECS.Task<ApiTask>()(
"ApiTask", { main: import.meta.filename, cpu: 256, port: 3000 },
Effect.gen(function* () { … return { fetch } }))`.

## Two modes in one resource: `main` is the switch

- `main` **omitted** → low-level primitive (plain `reconcile`/`delete`).
- `main` **set** → host mode: bundle `main` at deploy, ship the artifact,
  cloud-init/container bootstraps the process.
- **Diff rule**: flipping `main` on/off (host mode change) is a **replace**;
  code/env changes (`main`, `handler`, `port`, `env`, `build`) are an
  **update** (reboot/restart), never a replace.

## RuntimeContext — what init registers, what the bundle runs

`createHostRuntimeContext(type)` (`alchemy/Server`) is the shared host context
used by EC2.Instance and ECS.Task; don't write your own from scratch. It
collects:

- `host.run(effect)` (via `ServerHost`) — background loops, appended to
  runners.
- `serve(handler)` — HTTP handlers, also appended to runners (as
  `Http.serve(handler)`).
- `exports.program` — `Effect.all(runners, { concurrency: "unbounded" })`,
  the single effect the deployed entrypoint runs.

`BaseRuntimeContext` contract: `Type`, `id`, `env`, `set(key, output)` (plan
phase: store a config/binding capture), `get(key)` (runtime: read it back),
`exports?`, `serve?`. After init, `Platform` folds back onto props:
`news.env = { ...props.env, ...ctx.env }` and `news.exports = ctx.exports`.

## Provider reconcile: bundle → ship → reconcile

Each step is independently idempotent (observe → ensure → sync works for
creates, updates, adoption — do NOT branch on `output === undefined`):

1. **Apply the binding contract** — reconcile receives `bindings`; filter
   `action !== "delete"`, merge `data.env` into the shipped env and attach
   `data.policyStatements` to the identity (AWS: instance-profile role;
   Nebius: the instance's `serviceAccountId`). A binding removed from code
   arrives with `action: "delete"` — converge permissions down, not just up.
2. **Bundle the program** — `alchemy/Bundle` wraps rolldown:
   `Bundle.build({ input: entry, cwd, platform: "node", external: ["bun","bun:*"] }, { format: "esm", entryFileNames: "index.mjs" })`
   returns `{ files, hash }`. Ship **all** `files`, not just the entry —
   dynamic imports split into chunks; dropping one crashes the artifact at
   boot. Use `hash` as the immutable artifact version.
3. **Generated entrypoint** — the user's `main` exports the platform class,
   not a runnable program, so `Bundle.virtualEntryPlugin` wraps it:
   `handler → RuntimeContext.exports → exports.program → provide(platform layers + HTTP server on PORT) → Effect.runPromise`.
   `isExternal: true` skips the wrapper (user provides their own entry).
4. **Upload + bootstrap** — zip the files, upload bundle + rendered env file
   to an assets bucket, then generate the boot script. AWS reference
   (`AWS/EC2/hosted.ts`): cloud-init user-data installs bun/aws-cli, syncs the
   bundle from S3, installs a systemd unit (`ExecStart=/root/.bun/bin/bun
   index.mjs`, `Restart=always`) — user-supplied user-data is merged AFTER the
   generated bootstrap.

## Honor the phase split (plan vs runtime)

The same init Effect runs at plan time (records bindings, no cloud calls) and
at cold start inside the artifact (builds live clients). Two mechanisms:

- **`globalThis.__ALCHEMY_RUNTIME__`** — folded to `true` in every bundle by
  `Bundle.build` (rolldown `transform.define`); `if (!…guard)` provisioning
  code is dead-code-eliminated. ALSO guard provider exports with it (the D8
  pattern) so worker bundles DCE the deploy/gRPC graph.
- **`ALCHEMY_PHASE: "runtime"`** env key — `Platform` installs a
  `ConfigProvider` interceptor: at plan, every config lookup captures into the
  context via `ctx.set`; at runtime the same lookup resolves via `ctx.get`
  reading the env your provider shipped. `set`/`get` must agree on encoding
  (the host context JSON-serializes on set, `JSON.parse`s on get). Ship
  `ALCHEMY_STACK_NAME` + `ALCHEMY_STAGE` alongside.

## Applying this to the Nebius Instance

Current `Nebius.compute.v1.Instance` is exactly the low-level half (plain
Observe→Ensure→Sync CRUD). The hook already exists: `cloudInitUserData` in
`InstancePropsSchema` — the same mechanism AWS uses (`userData` merged with
the generated bootstrap). Everything needed ships in
`alchemy@2.0.0-beta.70`: `Platform` (from `alchemy`), `createHostRuntimeContext`
(`alchemy/Server`), `Bundle.build`/`virtualEntryPlugin` (`alchemy/Bundle`).

Design:

1. **Extend props** with the hosted set: `main?`, `handler?`, `port?`, `env?`,
   `build?`, `isExternal?` — and surface a constructor on
   `Platform("Nebius.compute.v1.Instance", { createRuntimeContext:
   createHostRuntimeContext(...) })`, keeping the current low-level path when
   `main` is omitted.
2. **Reconcile in host mode**: bundle + zip, upload bundle + env file to a
   Nebius S3 bucket (`storage.<region>.nebius.cloud`; region-scoped keys —
   there's already `Nebius.storage.v1.Bucket`), generate cloud-init user-data
   (install bun, fetch bundle via S3 keys or pre-signed URL, systemd unit
   running `bun index.mjs`), merge with `news.cloudInitUserData`.
3. **Bindings**: contract `{ env, policyStatements }`; instead of an EC2
   instance profile, attach statements to the instance's `serviceAccountId`
   (Nebius metadata service mints tokens) and merge env into the shipped env
   file.

Nebius gotchas vs the AWS reference: no instance-profile role bootstrap (use
service accounts), no `rebootInstances` (Nebius `start`/`stop`/`update`
semantics), and `InstanceSpec.fromJSON(news)` must thread the hosted props
through (hosted fields are platform-level, not spec-level). Host-mode diff:
`main` presence toggles host mode → replace; code/env changes → update.

## Related

- `alchemy-bindings.md` — binding impls, env derivation leniency, D8 provider
  guard (applies verbatim to an effectful provider)
- `AWS/EC2/Instance.ts` + `AWS/EC2/hosted.ts` (reference impl; `hosted.ts`'s
  user-data/systemd/bun bootstrap maps nearly 1:1 onto Nebius cloud-init)
- Docs: /infrastructure-as-effects/custom-runtime (Platform deep dive),
  /infrastructure-as-effects/phases (init/runtime split),
  /infrastructure-as-effects/functions-and-servers (Effectful Constructor)
