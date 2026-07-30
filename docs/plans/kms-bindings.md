# KMS Crypto Bindings — Implementation Plan

## Overview

Implement runtime bindings for Nebius KMS symmetric and asymmetric crypto
operations, following the same `Binding.Service` + `Layer.effect` pattern as
the storage and MysteryBox bindings. These let Lambda/Worker handlers
encrypt, decrypt, sign, and verify using keys managed in Nebius KMS without
the key material ever leaving the service.

## API surface

KMS exposes two crypto gRPC services (separate from the key lifecycle CRUD):

### SymmetricCryptoService

| RPC | Purpose |
|---|---|
| `encrypt(keyId, plaintext, aadContext?)` | Encrypt data; returns ciphertext |
| `decrypt(keyId, ciphertext, aadContext?)` | Decrypt data; returns plaintext |
| `generateDataKey(keyId, ...)` | Generate a local AES key + encrypted copy |
| `reEncrypt(keyId, ciphertext)` | Re-encrypt under same key (rotation support) |

### AsymmetricCryptoService

| RPC | Purpose |
|---|---|
| `sign(keyId, hash)` | Sign a hash with the private key |
| `getPublicKey(keyId)` | Return PEM-encoded public key |
| `encrypt(keyId, plaintext)` | Encrypt with the public key |
| `decrypt(keyId, ciphertext)` | Decrypt with the private key |

All are **unary gRPC calls** — no operations, no polling. Key material never
leaves KMS (except `getPublicKey`, which returns the public half).

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│ Consumer                                                  │
│   const key = yield* Nebius.kms.SymmetricKey("app-key")  │
│   const encrypt = yield* Nebius.kms.Encrypt(key)        │
│   const sign = yield* Nebius.kms.Sign(asymmetricKey)   │
│                                                           │
│   // In handler:                                          │
│   const { ciphertext } = yield* encrypt(plaintext)       │
│   const { signature } = yield* sign(hash)               │
└──────────────┬────────────────────────────────────────────┘
               │
    ┌──────────▼──────────────────────────────────┐
    │ Binding declarations (Binding.Service)      │
    │   Encrypt: (key) => (plaintext) => { ciphertext }│
    │   Decrypt: (key) => (ciphertext) => { plaintext }│
    │   Sign: (key) => (hash) => { signature }    │
    │   GetPublicKey: (key) => () => { publicKey } │
    └──────────┬──────────────────────────────────┘
               │  provided by Layer.effect
    ┌──────────▼──────────────────────────────────────┐
    │ Binding implementations (*Http.ts)               │
    │   Deploy-time:                                   │
    │     1. yield* Binding.Host                       │
    │     2. Reuse NebiusBindingCredentials               │
    │     3. host.bind() → inject NEBIUS_* env vars    │
    │   Runtime:                                       │
    │     4. Call KMS crypto gRPC with pre-filled keyId│
    └──────────────────────────────────────────────────┘
```

## Prerequisites

### Add crypto services to KMS gRPC client

The current `modules/api-client/kms.ts` only wraps the key lifecycle services.
Add crypto services to `KmsGrpcServiceShape`:

```ts
import * as SymmetricCryptoServiceSchema from
  '../../schemas/nebius/kms/v1/symmetric_crypto_service'
import type {
  SymmetricEncryptRequest, SymmetricEncryptResponse,
  SymmetricDecryptRequest, SymmetricDecryptResponse,
} from '../../schemas/nebius/kms/v1/symmetric_crypto_service'
import * as AsymmetricCryptoServiceSchema from
  '../../schemas/nebius/kms/v1/asymmetric_crypto_service'
import type {
  AsymmetricSignHashRequest, AsymmetricSignHashResponse,
  AsymmetricGetPublicKeyRequest, AsymmetricGetPublicKeyResponse,
} from '../../schemas/nebius/kms/v1/asymmetric_crypto_service'

export interface SymmetricCryptoService {
  readonly encrypt: (req: {
    keyId: string
    plaintext: Buffer
    aadContext?: Buffer
  }) => Effect.Effect<SymmetricEncryptResponse, GrpcError | GrpcDeadlineExceededError>
  readonly decrypt: (req: {
    keyId: string
    ciphertext: Buffer
    aadContext?: Buffer
  }) => Effect.Effect<SymmetricDecryptResponse, GrpcError | GrpcDeadlineExceededError>
}

export interface AsymmetricCryptoService {
  readonly sign: (req: {
    keyId: string
    hash: Buffer
  }) => Effect.Effect<AsymmetricSignHashResponse, GrpcError | GrpcDeadlineExceededError>
  readonly getPublicKey: (keyId: string) =>
    Effect.Effect<AsymmetricGetPublicKeyResponse, GrpcError | GrpcDeadlineExceededError>
}

export interface KmsGrpcServiceShape {
  readonly symmetricKey: SymmetricKeyService
  readonly asymmetricKey: AsymmetricKeyService
  readonly symmetricCrypto: SymmetricCryptoService   // ← NEW
  readonly asymmetricCrypto: AsymmetricCryptoService  // ← NEW
}
```

Implementation is straightforward — no polling, just wrap the raw gRPC calls:

```ts
const symCryptoRaw = yield* GrpcUtils.makeGrpcService(
  SymmetricCryptoServiceSchema.SymmetricCryptoServiceClient
)
const symmetricCrypto: SymmetricCryptoService = {
  encrypt: (req) =>
    GrpcUtils.callMethod(symCryptoRaw, 'encrypt',
      SymmetricCryptoServiceSchema.SymmetricEncryptRequest.fromPartial(req)
    ),
  decrypt: (req) =>
    GrpcUtils.callMethod(symCryptoRaw, 'decrypt',
      SymmetricCryptoServiceSchema.SymmetricDecryptRequest.fromPartial(req)
    ),
}
// ... same pattern for asymmetricCrypto
```

## File structure (all new)

```
modules/
└── bindings/
    └── kms/
        ├── client.ts              # Effect service wrapping crypto gRPC
        ├── encrypt.ts             # Encrypt binding (symmetric)
        ├── encrypt-http.ts
        ├── decrypt.ts             # Decrypt binding (symmetric)
        ├── decrypt-http.ts
        ├── sign.ts                # Sign binding (asymmetric)
        ├── sign-http.ts
        ├── get-public-key.ts      # GetPublicKey binding (asymmetric)
        └── get-public-key-http.ts
```

## Step 1: KMS Client Service (`bindings/kms/client.ts`)

Effect service wrapping the crypto gRPC calls. Provides a typed, testable
interface. Converts raw protobuf `Buffer` fields to/from `Uint8Array` for
caller convenience.

```ts
import * as Effect from "effect/Effect"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import { KmsGrpcService } from "../../../api-client/kms"

// ---- Service definition

export class KmsClient extends Context.Service(
  "Nebius.kms.KmsClient"
)<KmsClient>()("Nebius.kms.KmsClient", {
  encrypt: (
    keyId: string,
    plaintext: Uint8Array,
    aadContext?: Uint8Array,
  ) => Effect.Effect<{ ciphertext: Uint8Array }>,
  decrypt: (
    keyId: string,
    ciphertext: Uint8Array,
    aadContext?: Uint8Array,
  ) => Effect.Effect<{ plaintext: Uint8Array }>,
  sign: (
    keyId: string,
    hash: Uint8Array,
  ) => Effect.Effect<{ signature: Uint8Array }>,
  getPublicKey: (
    keyId: string,
  ) => Effect.Effect<{ publicKey: string }>,
}) {}

// ---- Layer

export const KmsClientLive = Layer.effect(
  KmsClient,
  Effect.gen(function* () {
    const grpc = yield* KmsGrpcService

    const toBuf = (u: Uint8Array) => Buffer.from(u)
    const toArr = (b: Buffer) => new Uint8Array(b)

    return KmsClient.of({
      encrypt: Effect.fn("Nebius.kms.encrypt")(
        function* (keyId, plaintext, aadContext) {
          const result = yield* grpc.symmetricCrypto.encrypt({
            keyId,
            plaintext: toBuf(plaintext),
            aadContext: aadContext ? toBuf(aadContext) : undefined,
          })
          return { ciphertext: toArr(result.ciphertext) }
        }
      ),

      decrypt: Effect.fn("Nebius.kms.decrypt")(
        function* (keyId, ciphertext, aadContext) {
          const result = yield* grpc.symmetricCrypto.decrypt({
            keyId,
            ciphertext: toBuf(ciphertext),
            aadContext: aadContext ? toBuf(aadContext) : undefined,
          })
          return { plaintext: toArr(result.plaintext) }
        }
      ),

      sign: Effect.fn("Nebius.kms.sign")(
        function* (keyId, hash) {
          const result = yield* grpc.asymmetricCrypto.sign({
            keyId,
            hash: toBuf(hash),
          })
          return { signature: toArr(result.signature) }
        }
      ),

      getPublicKey: Effect.fn("Nebius.kms.getPublicKey")(
        function* (keyId) {
          const result = yield* grpc.asymmetricCrypto.getPublicKey(keyId)
          return { publicKey: result.publicKey }
        }
      ),
    })
  })
)
```

**Design decisions:**
- `Uint8Array` instead of `Buffer` — platform-neutral (works in Workers)
- `aadContext` optional with `undefined` default — caller doesn't need to pass empty buffer
- Skips `generateDataKey` and `reEncrypt` for MVP — add later if needed

## Step 2: Binding Declarations

### Encrypt (symmetric key)

```ts
// encrypt.ts
import * as Effect from "effect/Effect"
import * as Binding from "alchemy/Binding"
import type { NebiusSymmetricKey } from "../../resources/kms/v1/symmetric-key.ts"

export interface Encrypt extends Binding.Service<
  Encrypt,
  "Nebius.kms.Encrypt",
  (
    key: NebiusSymmetricKey,
  ) => Effect.Effect<
    (plaintext: Uint8Array, aadContext?: Uint8Array) =>
      Effect.Effect<{ ciphertext: Uint8Array }>
  >
> {}
export const Encrypt = Binding.Service<Encrypt>("Nebius.kms.Encrypt")
```

### Decrypt (symmetric key)

```ts
// decrypt.ts
export interface Decrypt extends Binding.Service<
  Decrypt,
  "Nebius.kms.Decrypt",
  (key: NebiusSymmetricKey) => Effect.Effect<
    (ciphertext: Uint8Array, aadContext?: Uint8Array) =>
      Effect.Effect<{ plaintext: Uint8Array }>
  >
> {}
export const Decrypt = Binding.Service<Decrypt>("Nebius.kms.Decrypt")
```

### Sign (asymmetric key)

```ts
// sign.ts
import type { NebiusAsymmetricKey } from "../../resources/kms/v1/asymmetric-key.ts"

export interface Sign extends Binding.Service<
  Sign,
  "Nebius.kms.Sign",
  (key: NebiusAsymmetricKey) => Effect.Effect<
    (hash: Uint8Array) => Effect.Effect<{ signature: Uint8Array }>
  >
> {}
export const Sign = Binding.Service<Sign>("Nebius.kms.Sign")
```

### GetPublicKey (asymmetric key)

```ts
export interface GetPublicKey extends Binding.Service<
  GetPublicKey,
  "Nebius.kms.GetPublicKey",
  (key: NebiusAsymmetricKey) => Effect.Effect<
    () => Effect.Effect<{ publicKey: string }>
  >
> {}
export const GetPublicKey = Binding.Service<GetPublicKey>("Nebius.kms.GetPublicKey")
```

## Step 3: Binding Implementations

### EncryptHttp

```ts
// encrypt-http.ts
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Binding from "alchemy/Binding"
import { isFunction } from "alchemy/AWS/Lambda/Function"
import { Encrypt } from "./encrypt.ts"
import { KmsClient } from "./client.ts"
import { NebiusBindingCredentials } from "../storage/credentials.ts"
import type { NebiusSymmetricKey } from "../../resources/kms/v1/symmetric-key.ts"

export const EncryptHttp = Layer.effect(
  Encrypt,
  Effect.gen(function* () {
    const client = yield* KmsClient

    return Effect.fn(function* (key: NebiusSymmetricKey) {
      const keyId = yield* (key as any).id  // Output<string>

      // Deploy-time: wire host credentials
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host
        const creds = yield* NebiusBindingCredentials
        if (isFunction(host)) {
          yield* host.bind`NebiusAccess(${host}, Encrypt(${key}))`({
            env: {
              NEBIUS_S3_ENDPOINT: creds.s3Endpoint,
              NEBIUS_ACCESS_KEY_ID: creds.accessKeyId,
              NEBIUS_SECRET_KEY: creds.secretKey,
              NEBIUS_REGION: creds.region,
            },
          })
        }
      }

      // Runtime: call KMS gRPC with pre-filled key ID
      return Effect.fn(`Nebius.kms.Encrypt(${key.LogicalId})`)(
        function* (plaintext: Uint8Array, aadContext?: Uint8Array) {
          return yield* client.encrypt(yield* keyId, plaintext, aadContext)
        }
      )
    })
  })
)
```

DecryptHttp, SignHttp, GetPublicKeyHttp follow the identical pattern.

## Step 4: Module Exports

`modules/bindings/kms/index.ts`:
```ts
// Key resources (re-exported for convenience)
export { NebiusSymmetricKey } from "../../resources/kms/v1/symmetric-key.ts"
export { NebiusAsymmetricKey } from "../../resources/kms/v1/asymmetric-key.ts"

// Symmetric bindings
export { Encrypt } from "./encrypt.ts"
export { EncryptHttp } from "./encrypt-http.ts"
export { Decrypt } from "./decrypt.ts"
export { DecryptHttp } from "./decrypt-http.ts"

// Asymmetric bindings
export { Sign } from "./sign.ts"
export { SignHttp } from "./sign-http.ts"
export { GetPublicKey } from "./get-public-key.ts"
export { GetPublicKeyHttp } from "./get-public-key-http.ts"

// Runtime client
export { KmsClient, KmsClientLive } from "./client.ts"
```

`modules/index.ts`:
```ts
export * as kms from "./bindings/kms/index.ts"
```

## Step 5: Consumer Usage

```ts
import * as Nebius from "@fllstck/nebius-alchemy/modules"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"

Effect.gen(function* () {
  // Infrastructure: symmetric encryption key
  const appKey = yield* Nebius.kms.SymmetricKey("app-key", {
    algorithm: "AES_256",
  })

  // Infrastructure: signing key
  const signKey = yield* Nebius.kms.AsymmetricKey("sign-key", {
    algorithm: "RSA_2048_SIGN_PSS",
  })

  // Bind operations
  const encrypt = yield* Nebius.kms.Encrypt(appKey)
  const decrypt = yield* Nebius.kms.Decrypt(appKey)
  const sign = yield* Nebius.kms.Sign(signKey)
  const getPublicKey = yield* Nebius.kms.GetPublicKey(signKey)

  return {
    fetch: Effect.gen(function* () {
      // Encrypt sensitive data (key stays in KMS)
      const { ciphertext } = yield* encrypt(
        new TextEncoder().encode("secret data")
      )

      // Decrypt
      const { plaintext } = yield* decrypt(ciphertext)
      console.log(new TextDecoder().decode(plaintext))

      // Sign a hash
      const hash = yield* sha256("transaction-data")
      const { signature } = yield* sign(hash)

      // Get public key for external verification
      const { publicKey } = yield* getPublicKey()

      return HttpServerResponse.text("OK")
    }),
  }
}).pipe(
  Effect.provide(Layer.mergeAll(
    Nebius.kms.EncryptHttp,
    Nebius.kms.DecryptHttp,
    Nebius.kms.SignHttp,
    Nebius.kms.GetPublicKeyHttp,
    Nebius.kms.KmsClientLive,
  ))
)
```

## Relationship to other bindings

| Aspect | Storage (S3) | MysteryBox | KMS |
|---|---|---|---|
| **Transport** | S3 REST | gRPC | gRPC |
| **Pre-fill** | Bucket name | Secret ID | Key ID |
| **Operations** | 6 (CRUD + list) | 2 (get, getByKey) | 4 (encrypt, decrypt, sign, getPublicKey) |
| **Data format** | Binary + metadata | `Record<string, string>` | `Uint8Array` |
| **Credentials** | Same access key (reused) | Same access key (reused) | Same access key (reused) |

All three binding families share a single credential provision and inject the
same `NEBIUS_*` env vars via `NebiusBindingCredentials`.

## Testing Strategy

### Layer 1: KMS client integration test

```ts
// tests/bindings/kms/crypto.integration.test.ts
test.provider('Nebius.kms crypto operations', (stack) =>
  Effect.gen(function* () {
    // 1. Deploy a symmetric key
    const symKey = yield* stack.deploy(
      Nebius.kms.SymmetricKey('EncryptTest', { algorithm: 'AES_256' })
    )

    // 2. Provide KMS client
    const client = yield* KmsClient.pipe(
      Effect.provide(KmsClientLive)
    )

    // 3. Encrypt → Decrypt round-trip
    const plaintext = new TextEncoder().encode("secret message")
    const { ciphertext } = yield* client.encrypt(symKey.id, plaintext)
    expect(ciphertext).not.toEqual(plaintext)

    const { plaintext: decrypted } = yield* client.decrypt(symKey.id, ciphertext)
    expect(decrypted).toEqual(plaintext)

    // 4. AAD context: decrypt fails with wrong context
    const { ciphertext: withAad } = yield* client.encrypt(
      symKey.id, plaintext, new TextEncoder().encode("context")
    )
    const result = yield* client.decrypt(
      symKey.id, withAad, new TextEncoder().encode("wrong")
    ).pipe(Effect.either)
    expect(Effect.isLeft(result)).toBe(true)
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 180_000 },
)
```

### Layer 2: Binding unit test (mocked client)

Same pattern as storage and MysteryBox — mock `KmsClient`, verify pre-filled
key ID.

### Layer 3: Host wiring test

Skipped — requires Lambda/Worker host. Pattern is identical to storage bindings.

## Implementation Order

1. **Add `SymmetricCryptoService` + `AsymmetricCryptoService`** to `modules/api-client/kms.ts`
2. **`bindings/kms/client.ts`** — KmsClient service + live layer
3. **`bindings/kms/encrypt.ts`** + **`encrypt-http.ts`** — first binding (prove pattern)
4. **`bindings/kms/index.ts`** — module barrel
5. **`modules/index.ts`** — add kms bindings export
6. **Integration test** — end-to-end with a real KMS key
7. **`decrypt.ts`** + **`decrypt-http.ts`**
8. **`sign.ts`** + **`sign-http.ts`**
9. **`get-public-key.ts`** + **`get-public-key-http.ts`**
10. **Unit tests** — mocked client for each binding

Stop after step 6 to validate the pattern before building the remaining bindings.
