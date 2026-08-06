/**
 * The bindings example Worker — Effect-native entry.
 *
 * This file IS the Worker: it declares the bucket and consumes the typed
 * runtime clients. The stack (`bindings.ts`) deploys it via
 * `main: './bindings-worker.ts'` — keeping the entry separate from the stack
 * so the deployed bundle doesn't drag in the provider/runtime machinery.
 */
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as Layer from 'effect/Layer'
// Narrow subpath imports for OUR package — a namespace import of
// `@fllstck/nebius-alchemy` drags the whole surface (providers) into the
// worker bundle, defeating tree-shaking.
import { NebiusBucket } from '@fllstck/nebius-alchemy/resources/storage/v1/bucket.ts'
import {
  GetObject,
  GetObjectBinding,
  PutObject,
  PutObjectBinding,
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

    // Typed runtime clients — one per capability. The `*Binding` layers
    // provide the implementations (deploy-time grant + env wiring + the
    // s3-lite-client runtime); Effect.provide at the end supplies them.
    const getObject = yield* GetObject(bucket)
    const putObject = yield* PutObject(bucket)

    return {
      // GET /    → read 'dir/hello.txt' from the bucket and return it.
      // POST /   → write the request body to 'dir/hello.txt'.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest

        try {
          if (request.method === 'POST') {
            const body = yield* Effect.exit(request.text)
            if (Exit.isFailure(body)) {
              return HttpServerResponse.text(`error reading body: ${String(body.cause)}`, {
                status: 400,
              })
            }
            const outcome = yield* Effect.exit(
              putObject({
                key: 'dir/hello.txt',
                value: body.value ?? '',
                contentType: 'text/plain',
              }),
            )
            if (Exit.isFailure(outcome)) {
              return HttpServerResponse.text(`error: ${String(outcome.cause)}`, { status: 500 })
            }
            return HttpServerResponse.text('stored', { status: 201 })
          }

          const read = yield* Effect.exit(
            getObject({ key: 'dir/hello.txt' }).pipe(Effect.flatMap((result) => result.text)),
          )
          if (Exit.isFailure(read)) {
            return HttpServerResponse.text(`error: ${String(read.cause)}`, { status: 500 })
          }
          return HttpServerResponse.text(read.value, { status: 200 })
        } catch (error) {
          return HttpServerResponse.text(`handler error: ${String(error)}`, { status: 500 })
        }
      }),
    }
  }).pipe(
    // The binding implementations — swap for `*Http` layers on AWS later.
    Effect.provide(Layer.mergeAll(GetObjectBinding, PutObjectBinding)),
  ),
)
