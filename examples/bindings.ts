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

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { Stack, localState } from 'alchemy'
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'

import * as Cloudflare from 'alchemy/Cloudflare'
import * as Nebius from '@fllstck/nebius-alchemy'

export default Stack(
  'Bindings',
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Nebius.providers()),
    state: localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker(
      'Api',
      { main: import.meta.url },
      Effect.gen(function* () {
        const bucket = yield* Nebius.storage.Bucket('assets')

        const getObject = yield* Nebius.storage.GetObject(bucket)
        const putObject = yield* Nebius.storage.PutObject(bucket)

        return {
          fetch: Effect.gen(function* () {
            const request = yield* HttpServerRequest

            if (request.method === 'POST') {
              const body = yield* Effect.exit(request.text)
              if (Exit.isFailure(body))
                return HttpServerResponse.text(`error reading body: ${String(body.cause)}`, { status: 400 })

              const outcome = yield* Effect.exit(
                putObject({ key: 'hello.txt', value: body.value ?? '', contentType: 'text/plain' }),
              )
              if (Exit.isFailure(outcome))
                return HttpServerResponse.text(`error: ${String(outcome.cause)}`, { status: 500 })

              return HttpServerResponse.text('stored', { status: 201 })
            }

            const read = yield* Effect.exit(
              getObject({ key: 'hello.txt' }).pipe(Effect.flatMap((result) => result.text)),
            )

            if (Exit.isFailure(read)) return HttpServerResponse.text(`error: ${String(read.cause)}`, { status: 500 })

            return HttpServerResponse.text(read.value, { status: 200 })
          }),
        }
      }).pipe(Effect.provide(Nebius.storage.GetObjectBinding), Effect.provide(Nebius.storage.PutObjectBinding)),
    )
    return { workerUrl: worker.url }
  }),
)
