/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — typed Nebius S3 clients for a Cloudflare Worker
 *
 * The stack deploys the Effect-native worker from `bindings-worker.ts`:
 *   1. `bindings-worker.ts` declares the bucket + the `GetObject`/`PutObject`
 *      contracts inside the Worker impl.
 *   2. The `*Binding` layers do the deploy-time wiring: mint an SA → add it
 *      to the tenant's default `editors` group (the grant) → create an access
 *      key → inject `NEBIUS_S3_*` env bindings (`plain_text`/`secret_text`)
 *      into the Worker → register the bucket grant.
 *   3. At runtime the Worker's `fetch` handler reads those env bindings and
 *      talks to Nebius S3 with s3-lite-client.
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
import * as Layer from 'effect/Layer'
import * as Nebius from '@fllstck/nebius-alchemy'
import Api from './bindings-worker.ts'

export default Alchemy.Stack(
  'Bindings',
  {
    // Both provider sets: Nebius resources + the Cloudflare Worker host.
    providers: Layer.mergeAll(Cloudflare.providers()).pipe(Layer.provideMerge(Nebius.providers())),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api
    return { workerUrl: worker.url }
  }),
)
