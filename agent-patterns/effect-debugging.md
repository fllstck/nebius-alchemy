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

## `Effect.race` completes on the first SUCCESS — a failure waits for the loser

`Effect.race(a, b)` does **not** mean "whichever finishes first". It completes when
one side *succeeds*; if a side *fails*, the race keeps waiting for the other. With
`Effect.never` (or an infinite progress ticker) as the other side, a failure is
indistinguishable from a hang — the caller sees nothing, forever.

Found 2026-09-21 by bisecting a 5-second test timeout that should have been a
sub-second failure:

```ts
// hangs — the failure is swallowed and the race waits on `never`
await Effect.runPromise(Effect.race(Effect.fail(new Error('boom')), Effect.never))
// returns the failure immediately
await Effect.runPromise(Effect.raceFirst(Effect.fail(new Error('boom')), Effect.never))
```

**Where it bit:** the resource `delete` lifecycles raced the real delete against a
30-second "Still deleting …" progress ticker. A delete that *failed* therefore
looked like a delete that never finished — the 28 minutes of
`Still deleting Subnet …` that we attributed to a stalled server operation was
the ticker narrating a failure nobody could see. Two fixes, both applied:

- `Effect.raceFirst` wherever a real operation is raced against a ticker
  (`modules/resources/factory.ts`'s `runDeleteWithProgress`, used by
  `makeCrudDelete` *and* the Instance's custom delete).
- A bounded re-issue of a genuinely stalled delete (`timeoutOption` per attempt,
  then `DeleteStalledError`) — a real stall exists, but it was never the cause here.

**Generalised:** before racing, ask which side is *supposed* to fail, and pick the
combinator accordingly (`race` = first success, `raceFirst` = first completion,
`raceAll`/`raceAllFirst` for collections). A progress ticker is the worst thing to
race with `race`, because it never fails and never returns.

Two related v4 API notes, both discovered the same way:

- Timeout combinators are **data-last**: `Effect.timeoutOption(duration)(self)`,
  not `timeoutOption(self, duration)`. The wrong order type-checks as "duration"
  in some positions and silently never times out.
- `runDeleteWithProgress`-style helpers with a generic `E`/`R` need one cast:
  `Effect.gen` infers `unknown` for both when the surrounding function is generic.

