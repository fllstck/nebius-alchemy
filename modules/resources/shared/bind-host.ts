/**
 * M1 — Worker host env wiring ("the host half" of every Nebius binding).
 *
 * `bindWorkerEnv` registers Cloudflare `plain_text`/`secret_text` bindings on
 * the host Worker at deploy time. At runtime (deployed Worker or `alchemy dev`
 * local workerd) alchemy's bundler folds `globalThis.__ALCHEMY_RUNTIME__` to
 * `true` (`ALCHEMY_DEFINE` in `alchemy/Bundle`) and the guarded branch — the
 * binding registration — is DCE'd out of the bundle entirely (M0-verified).
 *
 * The pure `envToWorkerBindings` mapping is separated out for network-free unit
 * testing.
 *
 * @internal — used by binding modules (e.g. `modules/resources/storage/v1/bindings.ts`).
 *   Not part of the package's public namespace surface.
 */
import * as Effect from 'effect/Effect'
import * as Output from 'alchemy/Output'
import * as Redacted from 'effect/Redacted'
import { type Worker, type WorkerBinding } from 'alchemy/Cloudflare/Workers'

/**
 * A value to inject into the Worker env: plain text, a Redacted secret, or an
 * Output expression (resolved by `Output.evaluate` at apply time — the same
 * mechanism that resolves resource refs in props and binding data).
 */
export type EnvValue =
  | string
  | Redacted.Redacted<string>
  | Output.Output<string | Redacted.Redacted<string>>

/**
 * An env binding record with possibly-unresolved `text` (Output). The wire
 * `WorkerBinding` type only admits resolved strings; the deploy-time record
 * carries the Output and is resolved by the apply machinery before upload.
 */
export type EnvBinding =
  | { type: 'plain_text'; name: string; text: EnvValue }
  | { type: 'secret_text'; name: string; text: EnvValue }

/**
 * Map env entries to Cloudflare binding entries.
 *
 * - `string` values become `plain_text` bindings
 * - `Redacted` values become `secret_text` bindings (deployed as Cloudflare
 *   secrets, never visible in plaintext script settings)
 * - Output values pass through unresolved — the apply machinery evaluates
 *   them against the tracker before the Worker provider uploads the script
 */
export const envToWorkerBindings = (env: Record<string, EnvValue>): EnvBinding[] =>
  Object.entries(env).map(([name, value]) =>
    Redacted.isRedacted(value)
      ? { type: 'secret_text' as const, name, text: value }
      : { type: 'plain_text' as const, name, text: value },
  )

/**
 * Register env bindings on the host Worker.
 *
 * Deploy-time only. At runtime the `__ALCHEMY_RUNTIME__` guard is folded to
 * `false` by the bundler and this entire branch is removed from the bundle.
 *
 * `sid` identifies the binding record in the stack's binding registry — use a
 * stable, unique value per (host, capability), e.g. `"Nebius.storage.GetObject"`.
 */
export const bindWorkerEnv = Effect.fn('bindWorkerEnv')(function* (
  host: Worker,
  sid: string,
  env: Record<string, EnvValue>,
): Effect.fn.Return<void> {
  if (globalThis.__ALCHEMY_RUNTIME__) return
  // The deploy-time record carries possibly-unresolved Output text; the wire
  // WorkerBinding[] shape is only reached after apply-time evaluation. Cast:
  // Output fields are resolved by `Output.evaluate` before the Worker provider
  // uploads the script (same mechanism R2's bindings rely on).
  yield* host.bind(sid, { bindings: envToWorkerBindings(env) as unknown as WorkerBinding[] })
})
