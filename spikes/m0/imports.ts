/**
 * M0 spike — verify the type-level imports and patterns the bindings plan needs:
 *  1. `alchemy/Binding` — Binding.Service contract + callable pattern
 *  2. `alchemy/Cloudflare/Workers` — typed Worker host + WorkerEnvironment
 *     (NOTE: deep subpaths like `alchemy/Cloudflare/Workers/Worker` do NOT
 *     resolve — the exports map routes `./Cloudflare/*` to `index.ts`
 *     files only, not to nested `Workers/Worker.ts` file paths)
 *  3. WorkerBinding wire shape (plain_text / secret_text)
 *  4. `host.bind` tagged-template + bindings data on the Worker host
 *  5. `__ALCHEMY_RUNTIME__` guard global
 *
 * Scratch file — deleted after M0. Not part of the package.
 */
import * as Binding from 'alchemy/Binding'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Worker, WorkerEnvironment, isWorker } from 'alchemy/Cloudflare/Workers'
import type { WorkerBinding } from 'alchemy/Cloudflare/Workers'

declare global {
  // eslint-disable-next-line no-var
  var __ALCHEMY_RUNTIME__: boolean | undefined
}

// --- 1. Binding.Service contract (mirrors AWS.S3.GetObject) -----------------
export interface GetObject extends Binding.Service<
  GetObject,
  'Nebius.storage.v1.Bucket.GetObject',
  (bucket: { readonly name: string }) => Effect.Effect<
    (request: { readonly key: string }) => Effect.Effect<string, Error>
  >
> {}

export const GetObject = Binding.Service<GetObject>('Nebius.storage.v1.Bucket.GetObject')

// --- 2/3/4. CF binding Layer skeleton (mirrors R2.BucketBinding) ------------
export const GetObjectBinding = Layer.effect(
  GetObject,
  Effect.gen(function* () {
    const host = yield* Worker
    const env = yield* WorkerEnvironment

    return Effect.fn(function* (bucket: { readonly name: string }) {
      const BucketName = bucket.name

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const bindings: WorkerBinding[] = [
          { type: 'plain_text', name: 'NEBIUS_BUCKET_NAME', text: BucketName },
          { type: 'secret_text', name: 'NEBIUS_SECRET_ACCESS_KEY', text: 's3cr3t' },
        ]
        yield* host.bind`Nebius-storage(${bucket})`({ bindings })
      }

      return Effect.fn('Nebius.storage.Bucket.GetObject')(function* (request: { readonly key: string }) {
        const workerEnv = env as Record<string, string>
        return `get ${workerEnv.NEBIUS_BUCKET_NAME}/${request.key}`
      })
    })
  }),
)

// --- 5. isWorker guard on the host ------------------------------------------
export const assertHost = (value: unknown): void => {
  if (isWorker(value)) {
    // narrowed to the Worker host — would call host.bind here
    void value.LogicalId
  }
}

// --- 6. Nebius bucket attributes resolve as lazy Outputs in a binding impl ---
import * as Nebius from '@fllstck/nebius-alchemy'

export const BucketOutputProbe = Effect.fn('BucketOutputProbe')(function* () {
  const bucket = yield* Nebius.storage.Bucket('ProbeBucket')
  // Resource attribute access is lazy: `bucket.name` is an Effect yielding an
  // Accessor — double-yield to materialize (same as AWS S3 `bucket.bucketName`).
  const nameAccessor = yield* bucket.name
  const name: string = yield* nameAccessor
  const id: string = yield* yield* bucket.id
  return `${id}/${name}`
})
