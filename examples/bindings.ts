/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — typed Nebius S3 clients for a Cloudflare Worker (inline form)
 *
 * Everything in one file, matching the R2 `ReadWriteBucket` example shape:
 * the Worker + impl are declared inline; `main` points at this file. The
 * `*Binding` layers do the deploy-time wiring — host identity mint, editors
 * group grant, access key, `NEBIUS_S3_*` env injection — and the `fetch`
 * handler uses the typed runtime clients.
 *
 * Usage:
 *   NEBIUS_TENANT_ID=<tenant-id> alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID     (required)
 *   NEBIUS_REGION         (optional)  Default: eu-north1
 *   CLOUDFLARE_API_TOKEN / alchemy login   (required for the Worker deploy)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as Layer from 'effect/Layer'
import * as Nebius from '@fllstck/nebius-alchemy'
import { NebiusBucket } from '@fllstck/nebius-alchemy/resources/storage/v1/bucket.ts'
import {
  GetObject,
  GetObjectBinding,
  PutObject,
  PutObjectBinding,
} from '@fllstck/nebius-alchemy/resources/storage/v1/bindings.ts'

const Api = Cloudflare.Worker(
  'Api',
  // This file IS the worker entry.
  { main: import.meta.url },
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

        if (request.method === 'POST') {
          const body = yield* Effect.exit(request.text)
          if (Exit.isFailure(body)) {
            return HttpServerResponse.text(`error reading body: ${String(body.cause)}`, {
              status: 400,
            })
          }
          const outcome = yield* Effect.exit(
            putObject({ key: 'dir/hello.txt', value: body.value ?? '', contentType: 'text/plain' }),
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
      }),
    }
  }).pipe(
    // The binding implementations — swap for `*Http` layers on AWS later.
    Effect.provide(Layer.mergeAll(GetObjectBinding, PutObjectBinding)),
  ),
)

export default Alchemy.Stack(
  'Bindings',
  {
    providers: Layer.mergeAll(Cloudflare.providers()).pipe(Layer.provideMerge(Nebius.providers())),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api
    return { workerUrl: worker.url }
  }),
)
