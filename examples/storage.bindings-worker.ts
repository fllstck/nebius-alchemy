/**
 * The bindings example Worker — Effect-native entry (inline implementation).
 *
 * This file IS the Worker: it declares the bucket and consumes the typed
 * runtime clients, and the inline `Effect.gen` implementation is passed
 * directly to `Cloudflare.Worker`. The stack (`storage.bindings.ts`) imports this
 * construct and `yield*`s it, keeping the entry separate from the stack so
 * the deployed bundle doesn't drag in the provider/runtime machinery.
 *
 * ⚠️ Keep imports narrow: a namespace import of `@fllstck/nebius-alchemy`
 * (or `alchemy/Cloudflare`) drags the whole surface (providers, local
 * workerd runtime) into the worker bundle. Deep subpath imports let
 * rolldown tree-shake everything the handler doesn't use.
 */
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as Layer from 'effect/Layer'
import { NebiusBucket } from '@fllstck/nebius-alchemy/resources/storage/v1/bucket.ts'
import {
  GetObject,
  GetObjectHttp,
  PutObject,
  PutObjectHttp,
} from '@fllstck/nebius-alchemy/resources/storage/v1/bindings.ts'

export default Cloudflare.Worker(
  'Api',
  // The entry file itself — bundling `import.meta.url` here is safe: this
  // module only imports the contracts + effect runtime, not the stack.
  // Full minification: alchemy defaults to "dce-only", which ships ~2× the
  // bytes of a minified bundle.
  { main: import.meta.url, build: { output: { minify: true } } },
  Effect.gen(function* () {
    const bucket = yield* NebiusBucket('assets', {
      versioningPolicy: 'DISABLED',
      defaultStorageClass: 'STANDARD',
      objectAuditLogging: 'NONE',
      forceStorageClass: false,
    })

    // Typed runtime clients — one per capability. The `*Http` layers
    // provide the implementations (deploy-time grant + env wiring + the
    // s3-lite-client runtime); Effect.provide at the end supplies them.
    const getObject = yield* GetObject(bucket)
    const putObject = yield* PutObject(bucket)

    return {
      // GET /    → read 'hello.txt' from the bucket and return it.
      // POST /   → write the request body to 'hello.txt'.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest

        if (request.method === 'POST') {
          const body = yield* Effect.result(request.text)
          if (Result.isFailure(body))
            return HttpServerResponse.text(`error reading body: ${String(body.failure)}`, { status: 400 })

          const outcome = yield* Effect.result(
            putObject({ key: 'hello.txt', value: body.success ?? '', contentType: 'text/plain' }),
          )
          if (Result.isFailure(outcome))
            return HttpServerResponse.text(`error: ${String(outcome.failure)}`, { status: 500 })

          return HttpServerResponse.text('stored', { status: 201 })
        }

        const read = yield* Effect.result(getObject({ key: 'hello.txt' }).pipe(Effect.flatMap((result) => result.text)))

        if (Result.isFailure(read)) return HttpServerResponse.text(`error: ${String(read.failure)}`, { status: 500 })

        return HttpServerResponse.text(read.success, { status: 200 })
      }),
    }
  }).pipe(
    // The binding implementations — the AWS arm (`*FunctionHttp`) lands later.
    Effect.provide(Layer.mergeAll(GetObjectHttp, PutObjectHttp)),
  ),
)
