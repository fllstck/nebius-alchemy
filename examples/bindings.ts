/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — typed Nebius S3 clients for a Cloudflare Worker
 *
 * Demonstrates the binding pattern end-to-end:
 *   1. A Nebius bucket is declared inside the Worker body.
 *   2. `Nebius.storage.GetObject` / `PutObject` are called with the bucket —
 *      typed runtime clients (s3-lite-client under the hood).
 *   3. The `*Binding` layers do the deploy-time wiring: mint an SA → add it
 *      to the tenant's default `editors` group (the grant) → create an access
 *      key → inject `NEBIUS_S3_*` env bindings (`plain_text`/`secret_text`)
 *      into the Worker → register the bucket grant.
 *   4. At runtime the Worker's `fetch` handler reads those env bindings and
 *      talks to Nebius S3 with the SAME s3-lite-client.
 *
 * Usage:
 *   NEBIUS_TENANT_ID=<tenant-id> alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID     (required)
 *   NEBIUS_REGION         (optional)  Default: eu-north1
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

/** The Worker + the bindings it consumes. */
const Api = Cloudflare.Worker(
  'Api',
  // Effect-native Worker: the impl below IS the entry — no `main` file. A
  // `main: import.meta.url` here would bundle the whole stack module into the
  // worker script (dragging in the alchemy runtime + the workerd lib, whose
  // `require.resolve` shim fails under workerd).
  {},
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket('assets', {
      versioningPolicy: 'DISABLED',
      defaultStorageClass: 'STANDARD',
      objectAuditLogging: 'NONE',
      forceStorageClass: false,
    })

    // Typed runtime clients — one per capability. The `*Binding` layers
    // provide the implementations (deploy-time grant + env wiring + the
    // s3-lite-client runtime); Effect.provide at the end supplies them.
    const getObject = yield* Nebius.storage.GetObject(bucket)
    const putObject = yield* Nebius.storage.PutObject(bucket)

    return {
      // GET /    → read 'dir/hello.txt' from the bucket and return it.
      // POST /   → write 'hello from the bindings example' to 'dir/hello.txt'.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest

        if (request.method === 'POST') {
          const outcome = yield* Effect.exit(
            putObject({
              key: 'dir/hello.txt',
              value: 'hello from the bindings example',
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
      }),
    }
  }).pipe(
    // The binding implementations — swap for `*Http` layers on AWS later.
    Effect.provide(Layer.mergeAll(Nebius.storage.GetObjectBinding, Nebius.storage.PutObjectBinding)),
  ),
)

export default Alchemy.Stack(
  'Bindings',
  {
    // Both provider sets: Nebius resources + the Cloudflare Worker host.
    // (Cloudflare first; the Nebius layers are merged on top.)
    providers: Layer.mergeAll(Cloudflare.providers()).pipe(Layer.provideMerge(Nebius.providers())),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api
    return { workerUrl: worker.url }
  }),
)
