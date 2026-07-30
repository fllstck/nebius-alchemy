# MysteryBox Runtime Bindings — Implementation Plan

## Overview

Implement runtime bindings for Nebius MysteryBox secrets, following the same
`Binding.Service` + `Layer.effect` pattern as the storage bindings and AWS S3
bindings. These let Lambda/Worker handlers fetch decrypted secret payloads at
runtime without managing credentials or endpoints.

## API surface

MysteryBox exposes a `PayloadService` with two RPCs:

| RPC | Purpose |
|---|---|
| `Get(secretId, versionId?)` | Return all key-value payloads for a secret version (defaults to primary) |
| `GetByKey(secretId, key, versionId?)` | Return a single payload entry by key |

Both are **unary gRPC calls** (no operations, no polling). They return decrypted
payloads directly — MysteryBox handles encryption/decryption server-side.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Consumer                                            │
│   const secret = yield* Nebius.mysterybox.Secret(...)│
│   const getPayload = yield*                       │
│     Nebius.mysterybox.GetPayload(secret)           │
│                                                     │
│   // In handler:                                    │
│   const { API_KEY } = yield* getPayload()          │
│   // or:                                            │
│   const entry = yield* getPayloadByKey("API_KEY") │
└──────────────┬──────────────────────────────────────┘
               │
    ┌──────────▼──────────────────────────────────┐
    │ Binding declarations (Binding.Service)      │
    │   GetPayload: (secret) => () => PayloadMap  │
    │   GetPayloadByKey: (secret) => (key) => Entry│
    └──────────┬──────────────────────────────────┘
               │  provided by Layer.effect
    ┌──────────▼──────────────────────────────────────┐
    │ Binding implementations (*Http.ts)               │
    │   Deploy-time:                                   │
    │     1. yield* Binding.Host                       │
    │     2. Provision Nebius credentials (reuse       │
    │        storage/credentials.ts)                    │
    │     3. host.bind() → inject NEBIUS_* env vars    │
    │   Runtime:                                       │
    │     4. Call MysteryBox gRPC PayloadService       │
    │        with pre-filled secret ID                 │
    └──────────────────────────────────────────────────┘
```

## Prerequisites

### Add PayloadService to gRPC client

The current `modules/api-client/mysterybox.ts` only wraps `SecretService` and
`SecretVersionService` for CRUD lifecycle. We need the runtime `PayloadService`
too. Add to the `MysteryBoxGrpcServiceShape`:

```ts
import * as PayloadServiceSchema from '../../schemas/nebius/mysterybox/v1/payload_service'
import type { SecretPayload, SecretPayloadEntry } from '../../schemas/nebius/mysterybox/v1/payload_service'

export interface PayloadService {
  readonly get: (
    secretId: string,
    versionId?: string,
  ) => Effect.Effect<SecretPayload, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByKey: (
    secretId: string,
    key: string,
    versionId?: string,
  ) => Effect.Effect<SecretPayloadEntry, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
}

export interface MysteryBoxGrpcServiceShape {
  readonly secret: SecretService
  readonly secretVersion: SecretVersionService
  readonly payload: PayloadService  // ← NEW
}
```

Implementation in `MysteryBoxGrpcServiceLive`:

```ts
const payloadRaw = yield* GrpcUtils.makeGrpcService(
  PayloadServiceSchema.PayloadServiceClient
)
const payload: PayloadService = {
  get: (secretId, versionId) =>
    GrpcUtils.callMethod(payloadRaw, 'get', {
      secretId,
      versionId: versionId ?? '',
    }),
  getByKey: (secretId, key, versionId) =>
    GrpcUtils.callMethod(payloadRaw, 'getByKey', {
      secretId,
      key,
      versionId: versionId ?? '',
    }),
}
```

No operation polling needed — these are pure reads.

## File structure (all new)

```
modules/
└── bindings/
    └── mysterybox/
        ├── client.ts             # Effect service wrapping PayloadService gRPC
        ├── credentials.ts        # Re-import from bindings/storage/credentials.ts
    │                          # (same NebiusBindingCredentials service)
        ├── get-payload.ts        # GetPayload binding declaration
        ├── get-payload-http.ts   # GetPayload binding implementation
        ├── get-payload-by-key.ts
        └── get-payload-by-key-http.ts
```

## Step 1: MysteryBox Client Service (`bindings/mysterybox/client.ts`)

An Effect service wrapping the PayloadService gRPC calls. Same pattern as the
S3Client in the storage bindings plan — provides a typed, testable interface
that bindings use instead of calling gRPC directly.

```ts
import * as Effect from "effect/Effect"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Config from "effect/Config"
import { GrpcUtils } from "../../../api-client/grpc-utils"
import { MysteryBoxGrpcService } from "../../../api-client/mysterybox"

// ---- Service definition

export class MysteryBoxClient extends Context.Service(
  "Nebius.mysterybox.MysteryBoxClient"
)<MysteryBoxClient>()("Nebius.mysterybox.MysteryBoxClient", {
  getPayload: (secretId: string, versionId?: string) =>
    Effect.Effect<Record<string, string>>,
  getPayloadByKey: (secretId: string, key: string, versionId?: string) =>
    Effect.Effect<{ value: string } | undefined>,
}) {}

// ---- Layer

export const MysteryBoxClientLive = Layer.effect(
  MysteryBoxClient,
  Effect.gen(function* () {
    const grpc = yield* MysteryBoxGrpcService

    return MysteryBoxClient.of({
      getPayload: Effect.fn("Nebius.mysterybox.getPayload")(
        function* (secretId: string, versionId?: string) {
          const result = yield* grpc.payload.get(secretId, versionId)
          const map: Record<string, string> = {}
          for (const entry of result.data) {
            map[entry.key] = entry.stringValue ?? ""
          }
          return map
        }
      ),

      getPayloadByKey: Effect.fn("Nebius.mysterybox.getPayloadByKey")(
        function* (secretId: string, key: string, versionId?: string) {
          const result = yield* grpc.payload.getByKey(secretId, key, versionId)
          if (!result.data) return undefined
          return { value: result.data.stringValue ?? "" }
        }
      ),
    })
  })
)
```

**Design decisions:**
- Converts protobuf `Payload[]` → plain `Record<string, string>` — cleaner API for consumers
- `getPayloadByKey` returns `undefined` not an error when key is missing — typed optional
- Uses `Effect.fn` for OTel tracing, same as all provider code

## Step 2: Binding Declarations

### GetPayload

```ts
// get-payload.ts — binding declaration
import * as Effect from "effect/Effect"
import * as Binding from "alchemy/Binding"
import type { NebiusSecret } from "../../resources/mysterybox/v1/secret.ts"

/**
 * Runtime binding for fetching all payload entries from a MysteryBox secret.
 *
 * Bind to a secret to get a callable that returns the full decrypted payload
 * as a key-value map.
 */
export interface GetPayload extends Binding.Service<
  GetPayload,
  "Nebius.mysterybox.GetPayload",
  (
    secret: NebiusSecret,
  ) => Effect.Effect<
    (versionId?: string) => Effect.Effect<Record<string, string>>
  >
> {}
export const GetPayload = Binding.Service<GetPayload>("Nebius.mysterybox.GetPayload")
```

### GetPayloadByKey

```ts
// get-payload-by-key.ts — binding declaration
import * as Effect from "effect/Effect"
import * as Binding from "alchemy/Binding"
import type { NebiusSecret } from "../../resources/mysterybox/v1/secret.ts"

/**
 * Runtime binding for fetching a single payload entry by key from a
 * MysteryBox secret.
 */
export interface GetPayloadByKey extends Binding.Service<
  GetPayloadByKey,
  "Nebius.mysterybox.GetPayloadByKey",
  (
    secret: NebiusSecret,
  ) => Effect.Effect<
    (key: string, versionId?: string) => Effect.Effect<{ value: string } | undefined>
  >
> {}
export const GetPayloadByKey = Binding.Service<GetPayloadByKey>(
  "Nebius.mysterybox.GetPayloadByKey"
)
```

## Step 3: Binding Implementations

### GetPayloadHttp

```ts
// get-payload-http.ts — binding implementation
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Binding from "alchemy/Binding"
import { isFunction } from "alchemy/AWS/Lambda/Function"
import { GetPayload } from "./get-payload.ts"
import { MysteryBoxClient } from "./client.ts"
import { NebiusBindingCredentials } from "../storage/credentials.ts"
import type { NebiusSecret } from "../../resources/mysterybox/v1/secret.ts"

export const GetPayloadHttp = Layer.effect(
  GetPayload,
  Effect.gen(function* () {
    const client = yield* MysteryBoxClient

    return Effect.fn(function* (secret: NebiusSecret) {
      const secretId = yield* (secret as any).id  // Output<string>

      // Deploy-time: wire host credentials so gRPC works at runtime
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host
        const creds = yield* NebiusBindingCredentials

        if (isFunction(host)) {
          yield* host.bind`NebiusAccess(${host}, GetPayload(${secret}))`({
            env: {
              NEBIUS_S3_ENDPOINT: creds.s3Endpoint,
              NEBIUS_ACCESS_KEY_ID: creds.accessKeyId,
              NEBIUS_SECRET_KEY: creds.secretKey,
              NEBIUS_REGION: creds.region,
            },
          })
        }
      }

      // Runtime: call MysteryBox gRPC with pre-filled secret ID
      return Effect.fn(
        `Nebius.mysterybox.GetPayload(${secret.LogicalId})`
      )(function* (versionId?: string) {
        return yield* client.getPayload(yield* secretId, versionId)
      })
    })
  })
)
```

### GetPayloadByKeyHttp

Same pattern, delegates to `client.getPayloadByKey`.

## Step 4: Module Exports

`modules/bindings/mysterybox/index.ts`:
```ts
// Secret resource (re-exported for convenience)
export { NebiusSecret } from "../../resources/mysterybox/v1/secret.ts"

// Binding declarations
export { GetPayload } from "./get-payload.ts"
export { GetPayloadByKey } from "./get-payload-by-key.ts"

// Binding implementations
export { GetPayloadHttp } from "./get-payload-http.ts"
export { GetPayloadByKeyHttp } from "./get-payload-by-key-http.ts"

// Runtime client (for consumers who need raw access)
export { MysteryBoxClient, MysteryBoxClientLive } from "./client.ts"
```

`modules/index.ts`:
```ts
export * as mysterybox from "./bindings/mysterybox/index.ts"
```

## Step 5: Consumer Usage

```ts
import * as Nebius from "@fllstck/nebius-alchemy/modules"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

Effect.gen(function* () {
  // Infrastructure
  const apiKeys = yield* Nebius.mysterybox.Secret("api-keys", {
    payloads: [
      { key: "STRIPE_KEY", stringValue: "sk_live_..." },
      { key: "SENDGRID_KEY", stringValue: "sg_..." },
    ],
  })

  // Bind operations
  const getPayload = yield* Nebius.mysterybox.GetPayload(apiKeys)
  const getByKey = yield* Nebius.mysterybox.GetPayloadByKey(apiKeys)

  return {
    // Runtime handler
    fetch: Effect.gen(function* () {
      // Get all keys at once
      const all = yield* getPayload()
      // all = { STRIPE_KEY: "sk_live_...", SENDGRID_KEY: "sg_..." }

      // Or get a specific key
      const stripe = yield* getByKey("STRIPE_KEY")
      // stripe = { value: "sk_live_..." }

      return HttpServerResponse.text("OK")
    }),
  }
}).pipe(
  Effect.provide(Layer.mergeAll(
    Nebius.mysterybox.GetPayloadHttp,
    Nebius.mysterybox.GetPayloadByKeyHttp,
    Nebius.mysterybox.MysteryBoxClientLive,
  ))
)
```

## Differences from Storage Bindings

| Aspect | Storage (S3) | MysteryBox |
|---|---|---|
| **Transport** | S3 REST via `s3-lite-client` | gRPC via existing `MysteryBoxGrpcService` |
| **Pre-fill** | Bucket name | Secret ID |
| **Return type** | Binary + metadata | `Record<string, string>` or `{ value }` |
| **Operations** | 6 (Put, Get, Delete, Head, List, Copy) | 2 (GetPayload, GetPayloadByKey) |
| **Error typing** | S3 error codes | gRPC status codes |
| **Credentials** | S3 endpoint + access key | Nebius gRPC endpoint + access key (same) |

## Testing Strategy

### Layer 1: MysteryBox client integration test

```ts
// tests/bindings/mysterybox/payload.integration.test.ts
test.provider('Nebius.mysterybox payload operations', (stack) =>
  Effect.gen(function* () {
    // 1. Deploy a secret with known payloads
    const secret = yield* stack.deploy(
      Nebius.mysterybox.Secret('PayloadTest', {
        payloads: [
          { key: 'API_KEY', stringValue: 'secret-123' },
          { key: 'DB_URL', stringValue: 'postgres://...' },
        ],
      })
    )

    // 2. Provide the MysteryBox client
    const client = yield* MysteryBoxClient.pipe(
      Effect.provide(MysteryBoxClientLive)
    )

    // 3. GetPayload → verify all entries
    const all = yield* client.getPayload(secret.id)
    expect(all['API_KEY']).toBe('secret-123')
    expect(all['DB_URL']).toBe('postgres://...')

    // 4. GetPayloadByKey → verify single entry
    const entry = yield* client.getPayloadByKey(secret.id, 'API_KEY')
    expect(entry!.value).toBe('secret-123')

    // 5. Missing key → undefined
    const missing = yield* client.getPayloadByKey(secret.id, 'NOPE')
    expect(missing).toBeUndefined()
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 180_000 },
)
```

### Layer 2: Binding unit test (mocked client)

```ts
// tests/bindings/mysterybox/get-payload.test.ts
test('GetPayload binding pre-fills secret ID', () =>
  Effect.gen(function* () {
    const mockClient = { getPayload: mock(() => Effect.succeed({ KEY: 'val' })) }
    const mockLayer = Layer.succeed(MysteryBoxClient, MysteryBoxClient.of({
      getPayload: mockClient.getPayload,
    } as any))

    const get = yield* GetPayload.pipe(
      Effect.provide(GetPayloadHttp),
      Effect.provide(mockLayer),
    )

    const fakeSecret = { id: 'secret-abc123', LogicalId: 'MySecret' }
    const getPayload = yield* get(fakeSecret as any)
    const result = yield* getPayload()

    expect(result).toEqual({ KEY: 'val' })
    expect(mockClient.getPayload).toHaveBeenCalledWith('secret-abc123', undefined)
  }),
)
```

### Layer 3: Host wiring test

Skipped initially — same pattern as storage bindings. Requires a Lambda/Worker host.

## Implementation Order

1. **Add `PayloadService`** to `modules/api-client/mysterybox.ts`
2. **`bindings/mysterybox/client.ts`** — MysteryBoxClient service + live layer
3. **`bindings/mysterybox/get-payload.ts`** + **`get-payload-http.ts`**
4. **`bindings/mysterybox/get-payload-by-key.ts`** + **`get-payload-by-key-http.ts`**
5. **`bindings/mysterybox/index.ts`** — module barrel
6. **`modules/index.ts`** — add mysterybox bindings export
7. **Integration test** — end-to-end with a real Nebius secret
8. **Unit tests** — mocked client for each binding
