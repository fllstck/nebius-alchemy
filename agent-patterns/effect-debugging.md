# Debugging Effect — "what ran this effect?"

> From the 0.7.0 auth-bootstrap investigation (2026-09-18): the symptom was
> `Could not load auth providers`, and the cause was four layers away from where
> it surfaced. The techniques below found it; reasoning about the graph did not.

## Stack traces are useless inside effects

`new Error().stack` captured inside an `Effect.gen` body is flattened by Effect's
async trampoline:

```
Error: readEnvironment
    at <anonymous> (modules/AuthProvider.ts:707:25)
    at ~effect/Effect/successCont (effect/dist/internal/effect.js:990:28)
    at runLoop (…/effect.js:487:86)
    at <anonymous> (…/@effect/platform-node-shared/dist/NodeFileSystem.js:301:9)
```

There is no logical caller in there — only Effect internals and an unrelated
platform frame. `--log-level all` is no better: it prints the `Cause` (what
failed) but never who asked for it.

## Instrument the DECISION POINTS, not the failure

Log at each branch of the suspect function so the output names the path taken. In
the auth case the decisive fact was *which branch* ran, not the error text:

```ts
console.error('>>> [probe] gen started')
const { resolve } = yield* resolveProviderConfig(NAME)
console.error('>>> [probe] resolveProviderConfig returned OK')
return yield* resolve.pipe(
  Effect.tap(() => Effect.sync(() => console.error('>>> [probe] resolve EXECUTED'))),
  …
)
```

That single run killed the obvious theory: `resolve EXECUTED` never printed, so
nothing was resolving credentials at layer build — the demand had to come from a
different consumer.

## Bisect the LAYER GRAPH by providing subsets

When a composed layer fails and the responsible part is unclear, build a minimal
entrypoint that provides **only** the suspect layer, then add one layer at a time.
Two runs and the culprit is isolated:

| Entrypoint provides | Result |
| --- | --- |
| auth layer only | ✅ provider registers |
| auth layer + `Credentials.fromAuthProvider` | ❌ `Could not load auth providers` |

This is also the fastest answer to "does the CLI even see my provider?" — build a
stripped entrypoint rather than reading the whole dependency graph. Same spirit as
the `D8` guard work in `alchemy-bindings.md`: reduce the graph until only the
subject remains.

## Probe library semantics with a 5-line script

Do not reason about Effect's evaluation rules — measure them. Two that mattered:

```ts
// Effect.cached is LAZY: `yield*` yields a memoized effect without running it
let ran = false
const inner = Effect.sync(() => { ran = true; return 'v' })
yield* Effect.cached(inner)             // ran === false
yield* (yield* Effect.cached(inner))    // now ran === true
```

```ts
// A Context.Reference WITH a defaultValue is total: reading it does not widen R,
// and an unprovided read yields the default
const program: Effect.Effect<boolean> = Effect.gen(function* () {
  return yield* SomeReference      // typechecks with R = never; runtime → default
})
```

Same discipline as `effect-versioning.md` Rule 4 (verify renames at *runtime*, not
in `.d.ts`) — extended from existence to **semantics**. These probes take a minute
and settle arguments that otherwise run for hours.

## `Layer.orDie` hides typed failures from tag-matching consumers

A layer chain ending in `Layer.orDie` turns typed failures into **dies**. Callers
that classify errors can sometimes still read a die's defect
(`Cause.isDieReason(reason) ? reason.defect : …`), but **`Effect.catchTag` will
not catch a die**. In the auth case a bare `AuthError` die escaped a caller that
only handles `MissingProviderConfig`, so a recoverable "not configured yet"
condition surfaced as a hard CLI failure.

When a composed layer is consumed by code that dispatches on error tags, either
keep the failure typed or make sure the die's defect carries the tag the consumer
matches on. And check *how* the consumer inspects failures before assuming a
`catchTag` is enough.

## Related

- `effect-services.md` — `Context.Reference` semantics and layer composition
- `effect-versioning.md` Rule 4 — runtime verification of API existence
- `alchemy-bindings.md` — the D8 bundle guard, which is graph reduction for a
  different purpose
