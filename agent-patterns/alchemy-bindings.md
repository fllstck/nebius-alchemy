# Alchemy Binding-Implementation Patterns

> Hard-won from building Nebius S3 bindings for Cloudflare Workers. Read this
> before implementing ANY `Binding.Service` + Layer pair (storage, KMS,
> mysterybox, DNS…) — each item below cost real debugging time.

## Never resolve resource outputs inline in a binding impl

A binding impl declares resources lazily (`yield* Iam.ServiceAccount(...)`)
and needs their ids/values. **Do NOT resolve them via `yield* yield* sa.id`**
— the ambient `RuntimeContext` during a resource lifecycle is not the resolve
context, so this returns `undefined` (or hangs):

```ts
// ❌ Bad — undefined at deploy time
return new HostIdentity({
  serviceAccountId: yield* yield* sa.id,
})

// ✅ Good — pass the OUTPUT EXPRESSIONS through; alchemy resolves them where
// they're consumed (Input props + binding data run through `Output.evaluate`)
return { serviceAccountId: sa.id, groupId: group.id, awsAccessKeyId: key.awsAccessKeyId }
```

The alchemy-blessed precedent (R2 `BucketHttp`): `yield* bucket.bucketName`
yields an `Effect<string>` ACCESSOR that the runtime client resolves later —
never inline. Consequences:
- `HostIdentity`-style bundles hold `Output.Output<…>` (branded) fields, not strings.
- Grant calls pass the Outputs into resource props (Input resolves refs).
- Env values pushed to the Worker may be Outputs — the apply machinery
  (`Output.evaluate` on binding data) resolves them before upload.
- The R cast (erasing layer requirements) is legitimate at the stack boundary,
  but keep it encapsulated.

## Create in `reconcile`, not `precreate`, when the resource references a sibling

`precreate` receives **raw props** (refs unresolved — `waitForDeps` +
`Output.evaluate` only happen before `reconcile`). A resource whose create
needs another resource's id (an access key needs its SA) can NEVER be created
in the same deploy as that resource if it uses `precreate`. Move the create
into `reconcile` (when `output` is undefined) — refs resolve, one-time-secret
capture is unchanged. (Applied to `iam.v2.AccessKey`; unblocked the
hostIdentity one-deploy chain.)

## Effect-native Workers: entry structure for dev vs remote

- **Dev** (`alchemy dev`): the local provider accepts an impl with NO `main`.
- **Remote** (`alchemy deploy`): the provider REQUIRES `main`/`script`/`assets`.

Use a **separate entry file** with `main` pointing at it:

```ts
// examples/storage.bindings-worker.ts — the entry: impl + contracts + layers
export default Cloudflare.Worker('Api', { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket('assets', …)
    const getObject = yield* Nebius.storage.GetObject(bucket)
    return { fetch: … }
  }).pipe(Effect.provide(Layer.mergeAll(GetObjectHttp, PutObjectHttp))))

// examples/storage.bindings.ts — the stack
import Api from './storage.bindings-worker.ts'
export default Alchemy.Stack('Bindings', { providers: …, state: … },
  Effect.gen(function* () { const worker = yield* Api; return { workerUrl: worker.url } }))
```

NEVER point `main` at the stack file (`import.meta.url` of the stack): the
bundle drags in the provider/runtime machinery (including the `workerd` npm
lib whose `require.resolve` shim throws under workerd:
`Uncaught TypeError: e.resolve is not a function`).

## Shared env bindings must be registered once per host

Every capability of one host injects the SAME identity env (NEBIUS_* names).
Cloudflare rejects duplicate binding names in a single upload
(`Binding name 'X' already in use`). Dedupe by host + name:

```ts
const registeredEnvNames = new Set<string>()
const registerEnvOnce = … // filter already-registered names, skip empty, then host.bind
```

Module-level state is effectively per-deploy (`alchemy deploy` runs one deploy
per process; `alchemy dev` restarts the exec child per reload).

## Effect/API gotchas hit along the way

- `Effect.provide` has only a **single-layer curried overload** — for multiple
  layers chain the provides or use `Layer.mergeAll(...)` once.
- Effect-native `fetch` is an `HttpEffect`: the request comes via
  `yield* HttpServerRequest`, NOT a function argument.
- `HttpServerRequest.text` is an **Effect property** (`yield* request.text`),
  not a method.
- `Effect.either` does not exist in this Effect version — use `Effect.exit` +
  `Exit.isFailure`.
- A binding impl's layer requirements (`Worker | WorkerEnvironment`) can't be
  expressed in a stack effect's Req — satisfy them at the Worker impl boundary
  (Effect-native form) or cast at the stack boundary.

## Node compatibility for the CLI

Alchemy's CLI is Node-native (`#!/usr/bin/env node`) and its source uses
explicit `.ts` extensions. If your package uses extensionless relative imports
(`./Provider`), the CLI can't load it under Node and you're forced onto the
Bun path (known workerd spawn quirks). Add explicit `.ts` extensions to every
relative import (tsconfig needs `allowImportingTsExtensions` + `noEmit`) to
restore the Node path.

## Related

- `alchemy-test-patterns.md` — scratch-stack deploy semantics, staged deploys,
  idempotent deletes (the test-side counterpart)
- `tests/resources/storage/v1/bindings.integration.test.ts` — mocked-host impl
  test (runs the real layers with a `Self`-provided mock host)
