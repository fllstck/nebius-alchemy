/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — ASYNC-worker variant (tiny bundle)
 *
 * Same deploy-time wiring as `bindings.ts`, but the Worker is a plain async
 * entry (`bindings-async-worker.ts`): no Effect runtime in the bundle, so the
 * deployed size is a fraction of the Effect-native variant (~50-150 KB vs
 * ~2 MB). One call — `Nebius.storage.wireAsyncBindings(host, bucket)` — runs
 * the full deploy-time wiring: host identity mint, editors-group grant,
 * access key, `NEBIUS_S3_*` env injection. The async worker reads those env
 * bindings directly with s3-lite-client.
 *
 * The trade: the worker uses s3-lite directly from `env`, not the typed
 * `GetObject`/`PutObject` contracts.
 *
 * Usage:
 *   NEBIUS_TENANT_ID=<tenant-id> alchemy deploy --yes
 *   alchemy destroy --yes
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Nebius from '@fllstck/nebius-alchemy'
import { NebiusBucket } from '@fllstck/nebius-alchemy/resources/storage/v1/bucket.ts'

const Api = Cloudflare.Worker('Api', {
  // Resolve relative to this file (the stack lives in examples/), not the CWD.
  main: import.meta.resolve('./bindings-async-worker.ts', import.meta.url),
})

export default Alchemy.Stack(
  'BindingsAsync',
  {
    providers: Layer.mergeAll(Cloudflare.providers()).pipe(Layer.provideMerge(Nebius.providers())),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bucket = yield* NebiusBucket('assets', {
      versioningPolicy: 'DISABLED',
      defaultStorageClass: 'STANDARD',
      objectAuditLogging: 'NONE',
      forceStorageClass: false,
    })
    const host = yield* Api

    // The whole deploy-time wiring in one call — the worker reads the env at
    // runtime.
    yield* Nebius.storage.wireAsyncBindings(host, bucket)

    return { bucketId: bucket.id, bucketName: bucket.name }
  }),
)
