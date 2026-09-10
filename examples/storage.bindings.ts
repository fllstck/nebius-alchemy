/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — typed Nebius S3 clients for a Cloudflare Worker (inline form)
 *
 * The Worker + its inline `Effect.gen` implementation live in
 * `storage.bindings-worker.ts` (the entry's default export is the Worker construct);
 * this stack imports the construct and `yield*`s it, which runs its Init
 * phase at deploy time — host identity mint, editors group grant, access
 * key, `NEBIUS_S3_*` env injection — and the `fetch` handler uses the typed
 * runtime clients.
 *
 * Keeping the worker entry in its own file is what keeps the deployed
 * bundle clean: `main` points at `storage.bindings-worker.ts`, never at this stack
 * file, so the provider/runtime machinery imported here (for the CLI) never
 * ships inside the Worker.
 *
 * Usage:
 *   NEBIUS_TENANT_ID=<tenant-id> alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID     (required)
 *   NEBIUS_REGION         (optional)  Default: eu-north1
 *   CLOUDFLARE_API_TOKEN / alchemy profile edit --add Cloudflare   (required for the Worker deploy)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Stack, localState } from 'alchemy'

import * as Cloudflare from 'alchemy/Cloudflare'
import * as Nebius from '@fllstck/nebius-alchemy'
import Api from './storage.bindings-worker.ts'

export default Stack(
  'Bindings',
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Nebius.providers()),
    state: localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api
    return { workerUrl: worker.url }
  }),
)
