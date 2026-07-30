# Effect Services Patterns

> Extracted from `repos/effect-smol/LLMS.md` and `repos/effect-smol/ai-docs/`

## Defining a service with Context.Service

The default way to define a service is to extend `Context.Service`.

```ts
import { Context, Effect, Layer, Schema } from "effect"

export class Database extends Context.Service<Database, {
  query(sql: string): Effect.Effect<Array<unknown>, DatabaseError>
}>()(
  // String identifier — include package name + subdirectory path
  "myapp/db/Database",
) {
  // Attach a static layer to the service
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function*() {
      // Define methods using Effect.fn
      const query = Effect.fn("Database.query")(function*(sql: string) {
        yield* Effect.log("Executing SQL query:", sql)
        return [{ id: 1, name: "Alice" }]
      })

      // Return instance using Database.of
      return Database.of({ query })
    }),
  )
}

// Access the service interface type
export type DatabaseService = Database["Service"]
```

## Composing Layers

```ts
// Layer.provide — hides the dependency, exposes only the dependent
static readonly layer = this.layerNoDeps.pipe(
  Layer.provide(SqlClientLayer),
)

// Layer.provideMerge — exposes both the dependent and the dependency
static readonly layerWithSqlClient = this.layerNoDeps.pipe(
  Layer.provideMerge(SqlClientLayer),
)
```

## Creating Layers from Config + Effect

```ts
import { Config, Layer, Effect } from "effect"

const SqlClientLayer: Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  Config.ConfigError | SqlError.SqlError
> = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
})

// Dynamic layers with Layer.unwrap
const DynamicLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* Config.string("DYNAMIC_CONFIG")
    if (config === "special") {
      return SpecialLayer
    }
    return DefaultLayer
  }),
)
```

## Context.Reference for simple values

Use `Context.Reference` for configuration values, feature flags, or any service with a default value:

```ts
import { Context, Layer } from "effect"

export class MaxConnections extends Context.Reference<MaxConnections>()(
  "myapp/MaxConnections",
  { defaultValue: () => 10 },
) {}
```

## Patterns for this project

In the Nebius Alchemy provider codebase:

- **Use `Context.Service`** for services like `NebiusGrpcClient`, `TokenManager`, `AuthProvider`
- **Use `Layer.effect`** for constructing service implementations
- **Use `Layer.provideMerge`** when composing provider layers together
- **Use `Layer.orDie`** on credential layers to convert `ConfigError` to defects (satisfies Alchemy's `never` error constraint)
