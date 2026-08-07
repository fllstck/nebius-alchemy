/**
 * Replicates alchemy's Worker virtual entry (cf.
 * `alchemy/src/Cloudflare/Workers/Sources/Rolldown.ts:makeEffectVirtualEntry`):
 * the deployed script imports the real entry and builds the runtime bridge —
 * the real deploy bundles THIS, not the raw entry file.
 */
// @ts-nocheck — `cloudflare:workers` has no type declarations outside the CF plugin.
import * as Effect from 'effect/Effect'
import { env, DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { makeWorkerBridge } from 'alchemy/Cloudflare'
import { makeEntrypointLayer } from 'alchemy/Runtime'
import entrypoint from '../examples/ai.bindings-worker.ts'

const meta = {
  entrypoint,
  stack: {
    name: 'AiBindings',
    stage: 'dev',
  },
}

export default makeWorkerBridge(WorkerEntrypoint, meta)
