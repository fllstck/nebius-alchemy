# Schema Patterns

> Extracted from `repos/effect-smol/LLMS.md`, `repos/effect-smol/packages/effect/SCHEMA.md`, and `repos/effect-smol/ai-docs/`

## Defining domain models with Schema.Class

```ts
import { Schema } from "effect"

export class User extends Schema.Class<User>("path/to/module/User")({
  id: Schema.Number,
  name: Schema.NonEmptyString,
  email: Schema.String,
  role: Schema.Literals(["admin", "member"]),
}) {}

// Access the decoded TypeScript type
export type UserType = typeof User["Type"]  // ≡ User

// Access the encoded (serialized) type  
export type UserEncoded = typeof User["Encoded"]
```

## Tagged error classes with Schema.TaggedError

**Always use `Schema.TaggedError` for custom errors.** Never use plain `Error` subclasses.

> **Renamed in effect 4.0.0-rc.112.** This was `Schema.TaggedErrorClass` up to
> `4.0.0-beta.107`; the old name was **removed**, not aliased. If you see
> `TaggedErrorClass` anywhere, it is stale — see `agent-patterns/effect-versioning.md`.
> The call shape is unchanged, so the migration is a pure rename.

```ts
import { Effect, Schema } from "effect"

// Simple error
export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  input: Schema.String,
  message: Schema.String,
}) {}

// Error wrapping another error
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect(),
}) {}
```

Alchemy's own errors can also carry a brand marking them safe to show to users:

```ts
import { UserFacingError } from "alchemy/UserFacingError"

export class MyError extends Schema.TaggedError<MyError>()("MyError", {
  message: Schema.String,
}) {
  readonly [UserFacingError] = true
}
```

### Catching typed errors

```ts
// Catch specific errors by tag
loadPort("80").pipe(
  Effect.catchTag("ParseError", (_) => Effect.succeed(3000)),
  Effect.catchTag("ReservedPortError", (_) => Effect.succeed(3000)),
)

// Catch multiple errors in one call
loadPort("80").pipe(
  Effect.catchTag(["ParseError", "ReservedPortError"], (_) => Effect.succeed(3000)),
)

// Catch all remaining errors (last resort — prefer catchTag)
loadPort("invalid").pipe(
  Effect.catchTag("ReservedPortError", (_) => Effect.succeed(3000)),
  Effect.catch((_) => Effect.succeed(3000)),
)
```

## Decoding and encoding

**Reuse parsers** at the edges of your application:

```ts
// Create reusable parser/encoder
export const decodeUser = Schema.decodeUnknownEffect(User)
export const encodeUser = Schema.encodeEffect(User)

// Use within Effect code — errors stay typed in the error channel
export const parseUserPayload = Effect.fn("parseUserPayload")((input: unknown) =>
  decodeUser(input).pipe(
    Effect.mapError((error) => new InvalidUserPayload({ message: error.message }))
  )
)
```

### Key rules

- **Always validate untrusted data** with Schema — do NOT use predicates or manual parsing
- **Schema.Class** gives you both a TypeScript type and a runtime validator
- **Schema.TaggedError** gives you tagged errors catchable by string tag
- Register schema identifier strings with the `effect/LanguageService` for IDE support
- Read the full `SCHEMA.md` in the vendored repo for advanced topics (transformations, flips, classes, etc.)

### `Schema.Union` of two structs silently drops the excess key — measured 2026-09-23

```ts
const PercentOrCount = Schema.Union([
  Schema.Struct({ count: Schema.Finite }),
  Schema.Struct({ percent: Schema.Finite }),
])

decodeUnknownSync(PercentOrCount)({ count: 1, percent: 20 })  // → { count: 1 }  (percent GONE)
```

Effect's `Union` tries each member in order and *strips* keys the member does not declare (the
default excess-property behaviour), so a two-arm union of structs does **not** enforce
exclusivity — it silently picks the first arm that fits. For an API field that is genuinely
`{ count } | { percent }` (`mk8s/v1 PercentOrCount`, `security-rule`'s match blocks), one struct
with both keys optional plus an `.check(Schema.makeFilter(...))` rejects all three wrong shapes
(both set, neither set, out of range) **and** can name what the caller sent:

```ts
const PercentOrCount = Schema.Struct({
  count: Schema.optional(...),
  percent: Schema.optional(...),
}).check(Schema.makeFilter((v) =>
  (v.count !== undefined) === (v.percent !== undefined)
    ? `set exactly one of count or percent (got count=${v.count}, percent=${v.percent})`
    : undefined,
))
```

Use a `Union` for *shape* alternatives whose members are mutually exclusive by structure (a class
vs a literal), not for "one of these two keys" — that is a filter's job in this codebase (see
`Validation.presenceOnly`, `percentOrCount` in `modules/resources/mk8s/v1/node-group.schema.ts`).
