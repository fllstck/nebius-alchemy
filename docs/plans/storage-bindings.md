# Nebius Storage Bindings — Implementation Plan

## Overview

Implement S3-compatible runtime bindings for Nebius buckets, following the
exact pattern used by `alchemy/src/AWS/S3/`. Each binding has two files:
a **declaration** (`Binding.Service` tag + type) and an **implementation**
(`Layer.effect` providing the tag).

Bindings are cross-provider by design — they use the abstract `Binding.Host`
to wire credentials into whatever compute resource is deploying (Lambda,
Worker, etc.), and call the Nebius S3-compatible API at runtime.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Consumer                                            │
│   const bucket = yield* Nebius.storage.Bucket("x")  │
│   const put = yield* Nebius.storage.PutObject(bucket)│
│   yield* put({ Key: "hi", Body: "world" })          │
└──────────────┬──────────────────────────────────────┘
               │
    ┌──────────▼──────────────────────────┐
    │ Binding declaration (Binding.Service)│
    │   - Context tag for DI               │
    │   - Typed callable: (bucket) => fn   │
    └──────────┬──────────────────────────┘
               │  provided by Layer.effect
    ┌──────────▼──────────────────────────────────────┐
    │ Binding implementation (*Http.ts)                │
    │   Deploy-time (if !globalThis.__ALCHEMY_RUNTIME__):│
    │     1. yield* Binding.Host                       │
    │     2. Provision Nebius access key (new)         │
    │     3. host.bind() → inject env vars             │
    │   Runtime:                                       │
    │     4. Call S3-compatible API with pre-filled    │
    │        bucket name from bucket resource          │
    └──────────────────────────────────────────────────┘
```

## File structure (all new)

```
modules/
├── bindings/
│   └── storage/
│       ├── types.ts              # Shared S3 request/response types
│       ├── client.ts             # Effect service wrapping s3-lite-client
│       ├── credentials.ts        # Provision & resolve Nebius access keys
│       ├── put-object.ts         # PutObject binding declaration
│       ├── put-object-http.ts    # PutObject binding implementation
│       ├── get-object.ts
│       ├── get-object-http.ts
│       ├── delete-object.ts
│       ├── delete-object-http.ts
│       ├── head-object.ts
│       ├── head-object-http.ts
│       ├── list-objects-v2.ts
│       └── list-objects-v2-http.ts
└── resources/
    └── storage/
        └── v1/
            └── bucket.schema.ts  # ADD: endpoint attribute
            └── bucket.ts         # ADD: endpoint to Attributes
```

## Step 1: S3 Client Service (`bindings/storage/client.ts`)

An Effect service wrapping `@bradenmacdonald/s3-lite-client`. This is the
runtime layer — it reads credentials from env vars injected by the binding
and provides typed S3 operations.

```ts
import * as Effect from "effect/Effect"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Config from "effect/Config"
import { Client as S3LiteClient } from "@bradenmacdonald/s3-lite-client/client"

// ---- Service definition

export class S3Client extends Context.Service(
  "Nebius.storage.S3Client"
)<S3Client>()("Nebius.storage.S3Client", {
  putObject: (params: {
    bucket: string
    key: string
    body: string | Uint8Array
    contentType?: string
    cacheControl?: string
    metadata?: Record<string, string>
  }) => Effect.Effect<void>,
  getObject: (params: {
    bucket: string
    key: string
  }) => Effect.Effect<{ body: Uint8Array; contentType?: string; etag?: string }>,
  deleteObject: (params: {
    bucket: string
    key: string
  }) => Effect.Effect<void>,
  headObject: (params: {
    bucket: string
    key: string
  }) => Effect.Effect<{ contentType?: string; contentLength?: number; etag?: string }>,
  listObjectsV2: (params: {
    bucket: string
    prefix?: string
    delimiter?: string
    maxKeys?: number
    continuationToken?: string
  }) => Effect.Effect<{
    contents: Array<{ key: string; size: number; etag: string; lastModified: Date }>
    isTruncated: boolean
    nextContinuationToken?: string
  }>
}) {}

// ---- Layer

export const S3ClientLive = Layer.effect(
  S3Client,
  Effect.gen(function* () {
    const endpoint = yield* Config.string("NEBIUS_S3_ENDPOINT")
    const accessKey = yield* Config.string("NEBIUS_ACCESS_KEY_ID")
    const secretKey = yield* Config.string("NEBIUS_SECRET_KEY")
    const region = yield* Config.string("NEBIUS_REGION")

    const client = new S3LiteClient({
      endPoint: endpoint,
      accessKey: accessKey,
      secretKey: secretKey,
      region: region,
      pathStyle: true,
    })

    return S3Client.of({
      putObject: ({ bucket, key, body, contentType, cacheControl, metadata }) =>
        Effect.promise(() =>
          client.putObject({
            bucket,
            key,
            body,
            headers: {
              ...(contentType && { "Content-Type": contentType }),
              ...(cacheControl && { "Cache-Control": cacheControl }),
            },
            metadata,
          })
        ),

      getObject: ({ bucket, key }) =>
        Effect.promise(async () => {
          const res = await client.getObject({ bucket, key })
          return {
            body: res.body as Uint8Array,
            contentType: res.headers?.["content-type"],
            etag: res.headers?.etag,
          }
        }),

      deleteObject: ({ bucket, key }) =>
        Effect.promise(() => client.deleteObject({ bucket, key })),

      headObject: ({ bucket, key }) =>
        Effect.promise(async () => {
          const res = await client.headObject({ bucket, key })
          return {
            contentType: res.headers?.["content-type"],
            contentLength: res.headers?.["content-length"]
              ? Number(res.headers["content-length"])
              : undefined,
            etag: res.headers?.etag,
          }
        }),

      listObjectsV2: ({ bucket, prefix, delimiter, maxKeys, continuationToken }) =>
        Effect.promise(async () => {
          const res = await client.listObjectsV2({
            bucket,
            prefix,
            delimiter,
            maxKeys,
            continuationToken,
          })
          return {
            contents: (res.Contents ?? []).map(c => ({
              key: c.Key,
              size: c.Size,
              etag: c.ETag,
              lastModified: c.LastModified,
            })),
            isTruncated: res.IsTruncated ?? false,
            nextContinuationToken: res.NextContinuationToken,
          }
        }),
    })
  })
)
```

**Design decisions:**
- Uses `Config` for env var access — standard Effect pattern
- Wraps promise-based `s3-lite-client` with `Effect.promise`
- Exposes a simplified interface vs raw S3 — only what bindings need
- Not exported to consumers; internal to the binding layer

## Step 2: Binding Credentials (`bindings/storage/credentials.ts`)

A `Context.Service` that provides Nebius S3 credentials for all bindings.
Follows the Distilled `Credentials` pattern: a service tag + a `Layer.effect`
that resolves credentials lazily.

**One service for all binding families.** Nebius access keys are
service-account-scoped — a single key grants access to Storage S3,
MysteryBox gRPC, KMS gRPC, and any future Nebius service. All bindings
share this service via a single `Layer.provide`.

This is separate from the existing `NebiusCredentials` service (used for
gRPC API-key auth in the provider layer). Bindings use service-account
access keys (`NEBIUS_ACCESS_KEY_ID` + `NEBIUS_SECRET_KEY`) instead of
API keys.

> **Open question**: Does Nebius gRPC accept service account access keys for
> auth? If gRPC requires API keys, the `NebiusBindingCredentials` service
> must also inject `NEBIUS_API_KEY`. If gRPC supports access key auth, the
> same credentials work for both S3 and gRPC bindings.

```ts
import * as Effect from "effect/Effect"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Config from "effect/Config"

export class NebiusBindingCredentials extends Context.Service(
  "NebiusBindingCredentials"
)<NebiusBindingCredentials>()("NebiusBindingCredentials", {
  s3Endpoint: "",
  accessKeyId: "",
  secretKey: "",
  region: "",
}) {}

// MVP: read from environment (set by user or CI)
// Future: dynamically provision service account + access key via StaticKey
export const NebiusBindingCredentialsLive = Layer.effect(
  NebiusBindingCredentials,
  Effect.gen(function* () {
    const s3Endpoint = yield* Config.string("NEBIUS_S3_ENDPOINT")
    const accessKeyId = yield* Config.string("NEBIUS_ACCESS_KEY_ID")
    const secretKey = yield* Config.redacted("NEBIUS_SECRET_KEY")
    const region = yield* Config.string("NEBIUS_REGION")

    return NebiusBindingCredentials.of({
      s3Endpoint,
      accessKeyId,
      secretKey: secretKey.value,
      region,
    })
  })
)
```

**Future state**: Instead of reading from env, this layer should:
1. Create a Nebius service account for the host
2. Issue an access key via the `StaticKey` provider
3. Return the credentials

This follows the same pattern as AWS's IAM role provisioning — the
credentials are provisioned at deploy time and injected into the host
via `host.bind()`.

## Step 3: Add `endpoint` to Bucket Attributes

Update `bucket.schema.ts` to compute the S3 endpoint for each bucket:

```ts
// In BucketAttributesSchema, add:
endpoint: Schema.String  // e.g. "storage.eu-north1.nebius.cloud"
```

Update `bucket.ts` `toFriendlyAttributes` to include the endpoint.
Alternatively, compute it as a method on the binding side from the bucket's
`parentId` (project → region) — this avoids changing the provider.

## Step 4: Binding Declarations (`bindings/storage/put-object.ts`)

One file per operation, mirroring the `alchemy/src/AWS/S3/PutObject.ts` pattern.
Each declares the Binding.Service tag + typed callable shape:

```ts
// put-object.ts — binding declaration
import * as Effect from "effect/Effect"
import * as Binding from "alchemy/Binding"
import type { NebiusBucket } from "../../resources/storage/v1/bucket.ts"

export interface PutObjectRequest {
  Key: string
  Body: string | Uint8Array
  ContentType?: string
  CacheControl?: string
  Metadata?: Record<string, string>
}

/**
 * Runtime binding for Nebius S3 PutObject.
 *
 * Bind this operation to a bucket to get a callable that writes objects
 * without manually supplying the bucket name on every request.
 */
export interface PutObject extends Binding.Service<
  PutObject,
  "Nebius.storage.PutObject",
  (
    bucket: NebiusBucket,
  ) => Effect.Effect<
    (request: PutObjectRequest) => Effect.Effect<void>
  >
> {}
export const PutObject = Binding.Service<PutObject>("Nebius.storage.PutObject")
```

## Step 5: Binding Implementations (`bindings/storage/put-object-http.ts`)

One file per operation, mirroring `alchemy/src/AWS/S3/PutObjectHttp.ts`.
Two phases: deploy-time host wiring, runtime S3 call.

```ts
// put-object-http.ts — binding implementation
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Binding from "alchemy/Binding"
import { isFunction } from "alchemy/AWS/Lambda/Function"  // for Lambda hosts
import { PutObject, type PutObjectRequest } from "./put-object.ts"
import { S3Client } from "./client.ts"
import { NebiusBindingCredentials } from "./credentials.ts"
import type { NebiusBucket } from "../../resources/storage/v1/bucket.ts"

export const PutObjectHttp = Layer.effect(
  PutObject,
  Effect.gen(function* () {
    const s3client = yield* S3Client

    return Effect.fn(function* (bucket: NebiusBucket) {
      const bucketName = yield* (bucket as any).name  // Output<string>

      // Deploy-time: wire host credentials
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host
        const creds = yield* NebiusBindingCredentials

        if (isFunction(host)) {
          // Lambda host: inject Nebius S3 env vars
          yield* host.bind`NebiusAccess(${host}, PutObject(${bucket}))`({
            env: {
              NEBIUS_S3_ENDPOINT: creds.s3Endpoint,
              NEBIUS_ACCESS_KEY_ID: creds.accessKeyId,
              NEBIUS_SECRET_KEY: creds.secretKey,
              NEBIUS_REGION: creds.region,
            },
          })
        }
        // Future: add isWorker branch for Cloudflare hosts
      }

      // Runtime: call S3 API with pre-filled bucket
      return Effect.fn(
        `Nebius.storage.PutObject(${bucket.LogicalId})`
      )(function* (request: PutObjectRequest) {
        return yield* s3client.putObject({
          bucket: yield* bucketName,
          key: request.Key,
          body: request.Body,
          contentType: request.ContentType,
          cacheControl: request.CacheControl,
          metadata: request.Metadata,
        })
      })
    })
  })
)
```

## Step 6: Module Exports

`modules/index.ts`:
```ts
// ---- Bindings
export * as storage from "./bindings/storage/index.ts"
```

`modules/bindings/storage/index.ts`:
```ts
// Bucket resource (re-exported for convenience)
export { NebiusBucket } from "../../resources/storage/v1/bucket.ts"

// Binding declarations
export { PutObject } from "./put-object.ts"
export { GetObject } from "./get-object.ts"
export { DeleteObject } from "./delete-object.ts"
export { HeadObject } from "./head-object.ts"
export { ListObjectsV2 } from "./list-objects-v2.ts"

// Binding implementations (HTTP/S3-based)
export { PutObjectHttp } from "./put-object-http.ts"
export { GetObjectHttp } from "./get-object-http.ts"
export { DeleteObjectHttp } from "./delete-object-http.ts"
export { HeadObjectHttp } from "./head-object-http.ts"
export { ListObjectsV2Http } from "./list-objects-v2-http.ts"

// S3 client (for consumers who need raw access)
export { S3Client, S3ClientLive } from "./client.ts"

// Binding credentials (shared across all Nebius bindings)
export {
  NebiusBindingCredentials,
  NebiusBindingCredentialsLive,
} from "./credentials.ts"
```

## Step 7: Consumer Usage

```ts
import * as Nebius from "@fllstck/nebius-alchemy/modules"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

// In a Worker / Lambda:
Effect.gen(function* () {
  const bucket = yield* Nebius.storage.Bucket("assets")
  const put = yield* Nebius.storage.PutObject(bucket)
  const get = yield* Nebius.storage.GetObject(bucket)

  return {
    fetch: Effect.gen(function* () {
      const result = yield* get({ Key: "hello.txt" }).pipe(
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined))
      )
      if (!result) {
        return HttpServerResponse.text("Not found", { status: 404 })
      }
      return HttpServerResponse.text(new TextDecoder().decode(result.body))
    }),
  }
}).pipe(
  Effect.provide(Layer.mergeAll(
    Nebius.storage.PutObjectHttp,
    Nebius.storage.GetObjectHttp,
    Nebius.storage.S3ClientLive,
    Nebius.storage.NebiusBindingCredentialsLive,
  ))
)
```

## Cross-Provider Wiring Matrix

| Host | Deploy-time action | Runtime |
|---|---|---|
| **AWS Lambda** | `host.bind()` → env vars in Lambda config | S3 client reads `NEBIUS_*` env vars |
| **Cloudflare Worker** | `host.bind()` → WASM secret bindings | S3 client reads `NEBIUS_*` from worker env |
| **EC2 Instance** | `host.bind()` → env vars in user data | S3 client reads `NEBIUS_*` from process env |
| **Nebius VM** | `host.bind()` → env vars (hypothetical) | S3 client reads `NEBIUS_*` from process env |

## Key Differences from AWS S3 Bindings

| Aspect | AWS S3 | Nebius Storage |
|---|---|---|
| **IAM** | Auto-generated per-binding policy statements | No per-resource IAM; service account access key injected as env vars |
| **API client** | `@distilled.cloud/aws/s3` | `@bradenmacdonald/s3-lite-client` (S3-compatible) |
| **Bucket attributes** | `bucketArn`, `bucketName`, `bucketDomainName`, `bucketRegionalDomainName` | `name`, `endpoint` |
| **Host wiring** | `host.bind()` → IAM policy statements | `host.bind()` → env vars |
| **Error typing** | Typed Distilled SDK errors | Simplified — `NoSuchKey`-style tags TBD |

## Implementation Order

1. **`bindings/storage/types.ts`** — shared request/response types
2. **`bindings/storage/client.ts`** — S3Client service + S3ClientLive layer
3. **`bindings/storage/credentials.ts`** — NebiusBindingCredentials Context.Service + Live layer
4. **`bindings/storage/put-object.ts`** + **`put-object-http.ts`** — first binding (prove the pattern)
5. **`bindings/storage/index.ts`** — module barrel
6. **`modules/index.ts`** — add storage bindings export
7. **Test** — end-to-end with a real Nebius bucket
8. **`get-object.ts`** + **`get-object-http.ts`**
9. **`head-object.ts`** + **`head-object-http.ts`**
10. **`delete-object.ts`** + **`delete-object-http.ts`**
11. **`list-objects-v2.ts`** + **`list-objects-v2-http.ts`**

Stop after step 7 to validate the pattern before building the remaining four bindings.

## Testing Strategy

Three layers, mirroring the Distilled S3 test pattern (real cloud, no mocks for
the API layer).

### Layer 1: S3Client integration test (cloud-backed)

Exercises the S3Client Effect service against a real Nebius bucket. Same pattern
as our existing bucket lifecycle test in `tests/resources/storage/v1/bucket.integration.test.ts`.

```ts
// tests/bindings/storage/s3-client.integration.test.ts
import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy/modules'
import { S3Client, S3ClientLive } from '../../../modules/bindings/storage/client.ts'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider('Nebius.storage S3 operations', (stack) =>
  Effect.gen(function* () {
    // 1. Deploy a real Nebius bucket
    const bucket = yield* stack.deploy(
      Nebius.storage.Bucket('S3OpsTest', {})
    )
    expect(bucket.name).toBeDefined()

    // 2. Provide the S3 client with credentials from env
    const s3 = yield* S3Client.pipe(
      Effect.provide(S3ClientLive),
      Effect.provide(Effect.gen(function* () {
        const region = yield* Config.string('NEBIUS_REGION')
        return Layer.succeed(Config, {
          NEBIUS_S3_ENDPOINT: `https://storage.${region}.nebius.cloud`,
          NEBIUS_ACCESS_KEY_ID: (yield* Config.string('NEBIUS_ACCESS_KEY_ID')),
          NEBIUS_SECRET_KEY: Config.secret(yield* Config.string('NEBIUS_SECRET_KEY')),
          NEBIUS_REGION: region,
        })
      })),
    )

    // 3. Put → Get → verify round-trip
    yield* s3.putObject({
      bucket: bucket.name,
      key: 'test.txt',
      body: 'hello from alchemy',
    })

    const obj = yield* s3.getObject({ bucket: bucket.name, key: 'test.txt' })
    expect(new TextDecoder().decode(obj.body)).toBe('hello from alchemy')

    // 4. Head → verify metadata
    const head = yield* s3.headObject({ bucket: bucket.name, key: 'test.txt' })
    expect(head.contentLength).toBe(20)

    // 5. List → verify it's there
    const list = yield* s3.listObjectsV2({ bucket: bucket.name })
    expect(list.contents.some(c => c.key === 'test.txt')).toBe(true)

    // 6. Delete → verify it's gone
    yield* s3.deleteObject({ bucket: bucket.name, key: 'test.txt' })

    const after = yield* s3.listObjectsV2({ bucket: bucket.name })
    expect(after.contents.some(c => c.key === 'test.txt')).toBe(false)
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 180_000 },
)
```

**Credentials**: Reads `NEBIUS_ACCESS_KEY_ID`, `NEBIUS_SECRET_KEY`, and
`NEBIUS_REGION` from the environment. The same env vars that a real Lambda
or Worker would receive from the binding's deploy-time wiring.

### Layer 2: Binding runtime unit test (mocked S3Client)

Tests that each binding correctly pre-fills the bucket name and passes
parameters to the S3Client. No cloud resources needed.

```ts
// tests/bindings/storage/put-object.test.ts
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { expect, mock } from 'bun:test'
import { PutObject, PutObjectHttp } from '../../../modules/bindings/storage/put-object.ts'
import { S3Client } from '../../../modules/bindings/storage/client.ts'

test('PutObject binding pre-fills bucket name', () =>
  Effect.gen(function* () {
    // Mock S3Client
    const mockPutObject = mock(() => Effect.void)
    const mockLayer = Layer.succeed(S3Client, S3Client.of({
      putObject: mockPutObject,
    } as any))

    // Create binding with mocked client
    const put = yield* PutObject.pipe(
      Effect.provide(PutObjectHttp),
      Effect.provide(mockLayer),
    )

    // The bucket argument is normally resolved by Alchemy's Output system.
    // In tests we simulate a resolved bucket handle.
    const fakeBucket = { name: 'my-test-bucket', LogicalId: 'MyBucket' }
    const putObject = yield* put(fakeBucket as any)

    yield* putObject({
      Key: 'hello.txt',
      Body: 'world',
      ContentType: 'text/plain',
    })

    expect(mockPutObject).toHaveBeenCalledWith({
      bucket: 'my-test-bucket',
      key: 'hello.txt',
      body: 'world',
      contentType: 'text/plain',
    })
  }),
)
```

One such test per binding operation (Put, Get, Delete, Head, List).

### Layer 3: Host wiring test (skipped initially)

The deploy-time `host.bind()` path requires a real Alchemy host resource
(Lambda, Worker, etc.) to deploy into. This code path is identical to the
proven pattern in `alchemy/src/AWS/S3/PutObjectHttp.ts` — the only difference
is that we push `env` vars instead of `policyStatements`.

Skip until we have a host to wire into. When ready, add a test that:
1. Deploys a Lambda/Worker with a Nebius bucket binding
2. Verifies the host's env vars contain `NEBIUS_*` credentials
3. Calls the runtime handler to verify end-to-end connectivity

### Test execution

```bash
# All binding tests (requires Nebius credentials in env)
bun test tests/bindings/

# Integration test only (needs real cloud)
bun test tests/bindings/storage/s3-client.integration.test.ts

# Unit tests only (no cloud needed)
bun test tests/bindings/storage/put-object.test.ts
```

### Test file structure

```
tests/
└── bindings/
    └── storage/
        ├── s3-client.integration.test.ts   # Cloud-backed S3 operations
        ├── put-object.test.ts              # Unit: mocked S3Client
        ├── get-object.test.ts
        ├── delete-object.test.ts
        ├── head-object.test.ts
        └── list-objects-v2.test.ts
```
