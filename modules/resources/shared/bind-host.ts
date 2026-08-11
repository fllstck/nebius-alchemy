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
import * as Option from 'effect/Option'
import * as Output from 'alchemy/Output'
import * as Redacted from 'effect/Redacted'
import type { ResourceLike } from 'alchemy/Resource'
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
 * An explicit request to deploy a value as a Cloudflare `secret_text` binding.
 *
 * The wire shape requires `text` to be a **string** at upload, and the worker
 * provider maps `host.bind` data items passthrough — it does NOT unwrap
 * `Redacted` values in binding data (only the worker's `env` prop path does).
 * So: wrap the value in {@link secret} to force `secret_text`; the wrapped
 * value must resolve to a plain string at apply time (an Output resolving to
 * a Redacted would hit the wire as an object and fail startup).
 */
export interface SecretValue {
  readonly _tag: 'NebiusSecret'
  readonly value: EnvValue
}

/** Force a value to deploy as a Cloudflare secret (`secret_text`). */
export const secret = (value: EnvValue): SecretValue => ({ _tag: 'NebiusSecret', value })

const isSecretValue = (value: unknown): value is SecretValue =>
  typeof value === 'object' && value !== null && (value as { _tag?: string })._tag === 'NebiusSecret'

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
 * - {@link secret}-wrapped values become `secret_text` bindings (the wrapped
 *   value resolves to a string at apply time)
 * - direct `Redacted` values become `secret_text` with the secret UNWRAPPED
 *   here — the worker provider does not unwrap Redacted in `host.bind` data
 *   (only in the worker `env` prop), and the wire needs a string
 * - Output values pass through unresolved — the apply machinery evaluates
 *   them against the tracker before the Worker provider uploads the script
 */
export const envToWorkerBindings = (env: Record<string, EnvValue | SecretValue>): EnvBinding[] =>
  Object.entries(env).map(([name, value]) => {
    if (isSecretValue(value)) {
      return { type: 'secret_text' as const, name, text: value.value }
    }
    return Redacted.isRedacted(value)
      ? { type: 'secret_text' as const, name, text: Redacted.value(value) }
      : { type: 'plain_text' as const, name, text: value }
  })

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
  env: Record<string, EnvValue | SecretValue>,
): Effect.fn.Return<void> {
  if (globalThis.__ALCHEMY_RUNTIME__) return
  // The deploy-time record carries possibly-unresolved Output text; the wire
  // WorkerBinding[] shape is only reached after apply-time evaluation. Cast:
  // Output fields are resolved by `Output.evaluate` before the Worker provider
  // uploads the script (same mechanism R2's bindings rely on).
  yield* host.bind(sid, { bindings: envToWorkerBindings(env) as unknown as WorkerBinding[] })
})

/**
 * Register env bindings ONCE per (host, name).
 *
 * Cloudflare rejects duplicate binding names on a single upload, and every
 * capability (storage GetObject/PutObject, AI ChatCompletions, …) injects the
 * same shared values (S3 credentials, endpoint URL/token). The first
 * capability registers them; later ones skip the already-registered names.
 *
 * A module-level set is effectively per-deploy: `alchemy deploy` runs one
 * deploy per process, and `alchemy dev` restarts the exec child per reload.
 */
const registeredEnvNames = new Set<string>()

export const registerEnvOnce = Effect.fn('registerEnvOnce')(function* (
  host: Worker,
  sid: string,
  env: Record<string, EnvValue | SecretValue>,
): Effect.fn.Return<void> {
  const fresh = Object.fromEntries(
    Object.entries(env).filter(([name]) => !registeredEnvNames.has(`${host.LogicalId}:${name}`)),
  )
  if (Object.keys(fresh).length === 0) return
  for (const name of Object.keys(fresh)) registeredEnvNames.add(`${host.LogicalId}:${name}`)
  yield* bindWorkerEnv(host, sid, fresh)
})

// ---------------------------------------------------------------------------
// Host-kind guards + generic env registration (Task 5)
// ---------------------------------------------------------------------------

/** A host exposing the alchemy `{ env, policyStatements }` bind contract. */
export interface EnvBindingHost extends ResourceLike {
  bind: (sid: string, data: { env: Record<string, unknown>; policyStatements: never[] }) => Effect.Effect<void>
}

/** `Nebius.compute.v1.Instance` — the default binding host (Effectful Constructor runtime). */
export const isNebiusInstanceHost = (host: unknown): host is EnvBindingHost =>
  typeof host === 'object' && host !== null && (host as { Type?: unknown }).Type === 'Nebius.compute.v1.Instance'

/** `Cloudflare.Worker` — the compatibility wrapper host. */
export const isCloudflareWorkerHost = (host: unknown): host is Worker =>
  typeof host === 'object' && host !== null && (host as { Type?: unknown }).Type === 'Cloudflare.Worker'

/** Any host the Nebius bindings can attach to (instance — default — or Worker). */
export const isNebiusBindingHost = (host: unknown): host is EnvBindingHost | Worker =>
  isNebiusInstanceHost(host) || isCloudflareWorkerHost(host)

/**
 * Unwrap a binding env value to the plain value the INSTANCE env file needs.
 * Cloudflare-only decorations (the `secret()` marker, Redacted) are resolved
 * here — the instance's env file is plaintext on the VM, and the reconcile's
 * `hostedEnv()` merge expects plain values (Outputs resolve at apply).
 */
const unwrapForInstance = (value: EnvValue | SecretValue): unknown => {
  if (isSecretValue(value)) {
    const inner = value.value
    return Redacted.isRedacted(inner) ? Redacted.value(inner) : inner
  }
  if (Redacted.isRedacted(value)) return Redacted.value(value)
  return value
}

/**
 * Register env bindings on an INSTANCE host (the default path).
 *
 * The payload is the alchemy `{ env, policyStatements }` contract (EC2
 * precedent): the instance reconcile merges `data.env` into the shipped env
 * file. `policyStatements` is always empty — Nebius authorizes via IAM
 * AccessPermits, not inline policies. The values are stored with Outputs
 * intact (resolved by the engine at apply time); the CF-only secret markers
 * are unwrapped here.
 */
export const bindInstanceHostEnv = Effect.fn('bindInstanceHostEnv')(function* (
  host: EnvBindingHost,
  sid: string,
  env: Record<string, EnvValue | SecretValue>,
): Effect.fn.Return<void> {
  const plain = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, unwrapForInstance(value)]))
  yield* host.bind(sid, { env: plain, policyStatements: [] })
})

/** The generic runtime env source: `WorkerEnvironment` when on a Worker, `process.env` otherwise. */
export const runtimeEnv = (host: unknown, workerEnv: Option.Option<Readonly<Record<string, unknown>>>): Readonly<Record<string, unknown>> =>
  isCloudflareWorkerHost(host) && Option.isSome(workerEnv)
    ? workerEnv.value
    : process.env
