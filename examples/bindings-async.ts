/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — ASYNC-worker variant (tiny bundle)
 *
 * Same deploy-time wiring as `bindings.ts`, but the Worker is a plain async
 * entry (`bindings-async-worker.ts`): no Effect runtime in the bundle, so the
 * deployed size is a fraction of the Effect-native variant (~50-150 KB vs
 * ~2 MB). The `*Binding` layers still run at deploy time — host identity
 * mint, editors-group grant, access key, `NEBIUS_S3_*` env injection — and
 * the async worker reads those env bindings directly with s3-lite-client.
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
import { Self } from 'alchemy/Self'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import * as Nebius from '@fllstck/nebius-alchemy'
import { NebiusBucket } from '@fllstck/nebius-alchemy/resources/storage/v1/bucket.ts'
import {
  GetObject,
  GetObjectBinding,
  PutObject,
  PutObjectBinding,
} from '@fllstck/nebius-alchemy/resources/storage/v1/bindings.ts'

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

    // Run the binding layers' deploy-time wiring (hostIdentity → grant →
    // env bindings) against the REAL host. In an Effect-native worker the
    // layers consume the host via the Worker impl's own context; here we
    // provide `Self<Cloudflare.Worker>` with the deployed host so the layers
    // resolve it. The runtime side of the layers is unused — the async worker
    // reads the injected env directly.
    const wire = <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E, never> =>
      effect as Effect.Effect<A, E, never>
    yield* wire(
      GetObject(bucket).pipe(
        Effect.provide(Layer.mergeAll(GetObjectBinding)),
        Effect.provide(Layer.succeed(Self('Cloudflare.Worker'), host)),
        Effect.provide(Layer.succeed(WorkerEnvironment, {})),
      ),
    )
    yield* wire(
      PutObject(bucket).pipe(
        Effect.provide(Layer.mergeAll(PutObjectBinding)),
        Effect.provide(Layer.succeed(Self('Cloudflare.Worker'), host)),
        Effect.provide(Layer.succeed(WorkerEnvironment, {})),
      ),
    )

    return { bucketId: bucket.id, bucketName: bucket.name }
  }),
)
