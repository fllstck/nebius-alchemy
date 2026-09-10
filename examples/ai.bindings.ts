/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — typed Nebius AI endpoint client for a Cloudflare Worker
 * (inline form)
 *
 * The Worker + its inline `Effect.gen` implementation live in
 * `ai.bindings-worker.ts` (the entry's default export is the Worker
 * construct); this stack imports the construct and `yield*`s it, which runs
 * its Init phase at deploy time — endpoint + network + subnet creation, and
 * `NEBIUS_ENDPOINT_URL`/`NEBIUS_ENDPOINT_AUTH_TOKEN` env injection (the URL
 * resolves only once the endpoint is RUNNING — the deploy fails early with
 * `EndpointNotRunning` otherwise). The `fetch` handler uses the typed
 * runtime client.
 *
 * Keeping the worker entry in its own file is what keeps the deployed
 * bundle clean: `main` points at `ai.bindings-worker.ts`, never at this
 * stack file, so the provider/runtime machinery imported here (for the CLI)
 * never ships inside the Worker.
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
 *
 * ⚠️ Billable resources: this deploys a real inference endpoint (VM) —
 *   destroy it when you're done. See AI_BINDINGS.md for the design.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Stack, localState } from 'alchemy'

import * as Cloudflare from 'alchemy/Cloudflare'
import * as Nebius from '@fllstck/nebius-alchemy'
import Api from './ai.bindings-worker.ts'

export default Stack(
  'AiBindings',
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Nebius.providers()),
    state: localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api
    return { workerUrl: worker.url }
  }),
)
