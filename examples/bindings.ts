/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — typed Nebius S3 clients for a Cloudflare Worker
 *
 * Demonstrates the binding pattern end-to-end:
 *   1. A Nebius bucket + a Cloudflare Worker are declared in the stack.
 *   2. `Nebius.storage.GetObject` / `PutObject` are called with the bucket —
 *      typed runtime clients (s3-lite-client under the hood).
 *   3. The `*Binding` layers do the deploy-time wiring: mint an SA → add it
 *      to the tenant's default `editors` group (the grant) → create an access
 *      key → inject `NEBIUS_S3_*` env bindings (`plain_text`/`secret_text`)
 *      into the Worker → register the bucket grant.
 *   4. At runtime the Worker reads those env bindings and talks to Nebius S3
 *      with the SAME s3-lite-client (see `bindings-worker.ts`).
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
import * as Layer from 'effect/Layer'
import * as Nebius from '@fllstck/nebius-alchemy'

/** The Worker host the bindings attach to (env injected at deploy time). */
const Api = Cloudflare.Worker('Api', { main: import.meta.url })

export default Alchemy.Stack(
  'Bindings',
  {
    // Both provider sets: Nebius resources + the Cloudflare Worker host.
    providers: Layer.mergeAll(Nebius.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket('assets', {
      versioningPolicy: 'DISABLED',
      defaultStorageClass: 'STANDARD',
      objectAuditLogging: 'NONE',
      forceStorageClass: false,
    })
    yield* Api

    // Typed runtime clients — one per capability. The `*Binding` layers
    // provide the implementations (deploy-time grant + env wiring + the
    // s3-lite-client runtime). Effect.provide at the end supplies them.
    const getObject = yield* Nebius.storage.GetObject(bucket)
    const putObject = yield* Nebius.storage.PutObject(bucket)

    // `getObject` / `putObject` are the functions the Worker entry uses:
    //   const result = yield* getObject({ key: 'dir/hello.txt' })
    //   yield* putObject({ key: 'dir/hello.txt', body: '…', contentType: 'text/plain' })
    // (At deploy time they also exist here for any pre-warm calls you want to
    // run during the deploy — e.g. seeding an object.)

    return {
      bucketId: bucket.id,
      bucketName: bucket.name,
      worker: Api.id,
    }
  }).pipe(
    // The binding implementations — swap for `*Http` layers on AWS later.
    Effect.provide(Nebius.storage.GetObjectBinding, Nebius.storage.PutObjectBinding),
  ),
)
