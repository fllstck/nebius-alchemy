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

## Tagged error classes with Schema.TaggedErrorClass

**Always use `Schema.TaggedErrorClass` for custom errors.** Never use plain `Error` subclasses.

```ts
import { Effect, Schema } from "effect"

// Simple error
export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
  input: Schema.String,
  message: Schema.String,
}) {}

// Error wrapping another error
export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect(),
}) {}
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
- **Schema.TaggedErrorClass** gives you tagged errors catchable by string tag
- Register schema identifier strings with the `effect/LanguageService` for IDE support
- Read the full `SCHEMA.md` in the vendored repo for advanced topics (transformations, flips, classes, etc.)
