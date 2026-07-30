# Effect.fn & Effect.gen Patterns

> Extracted from `repos/effect-smol/LLMS.md` and `repos/effect-smol/ai-docs/`

## Effect.fn — preferred over `() => Effect.gen(...)`

**Do not create functions that return an `Effect.gen`.** Use `Effect.fn` instead.

```ts
// ❌ Bad — avoid returning Effect.gen directly
export const bad = (n: number) =>
  Effect.gen(function*() {
    yield* Effect.logInfo("Received:", n)
    return n * 2
  })

// ✅ Good — use Effect.fn
export const good = Effect.fn("good")(
  function*(n: number): Effect.fn.Return<number, never> {
    yield* Effect.logInfo("Received:", n)
    return n * 2
  },
)
```

### Return type annotation

Use `Effect.fn.Return<A, E, R>` as the return type annotation on the generator:

```ts
Effect.fn("myFunction")(
  function*(input: string): Effect.fn.Return<string, MyError> {
    return yield* doSomething(input)
  },
  // No .pipe — pass combinators as additional arguments
  Effect.catchTag("MyError", (_) => Effect.succeed("fallback")),
  Effect.annotateLogs({ method: "myFunction" }),
)
```

### Key rules

- **Name string** must match the function name (improves stack traces, creates OTel span)
- **Do NOT use `.pipe` with `Effect.fn`** — pass combinators as additional arguments
- **Always `return yield*`** when raising an error so TypeScript knows execution stops
- The name appears as a named span in OpenTelemetry automatically

## Effect.gen — use inside Effect.fn or Layer constructors

```ts
// Inside a Layer effect — Effect.gen is fine here
Layer.effect(
  MyService,
  Effect.gen(function*() {
    const dep = yield* OtherService
    return MyService.of({ ... })
  })
)
```

## When to use which

| Pattern | When |
|---------|------|
| `Effect.fn("name")(function*() { ... })` | Top-level functions returning Effect |
| `Effect.gen(function*() { ... })` | Inline effects inside services, Layers, or tests |
| `return yield* effect` | Always use this pattern when the effect might fail |

## Additional combinators via `.pipe` (only outside Effect.fn)

When NOT using `Effect.fn`, use `.pipe` to chain:

```ts
loadPort("80").pipe(
  Effect.catchTag("ParseError", (_) => Effect.succeed(3000)),
  Effect.delay("1 second"),
)
```

## Effect.fn.Return type

```ts
type Return<A, E = never, R = never> = Generator<
  Effect.Effect<A, E, R>,
  A,
  Effect.Effect<A, E, R>
>
```

Use it as the return type annotation on the generator function inside `Effect.fn`.
