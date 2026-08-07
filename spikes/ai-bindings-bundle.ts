/**
 * AD8 bundle-safety spike (M4 follow-up): prove the AI bindings worker entry
 * bundles clean — zero gRPC markers, no Node-only builtins, no
 * `__ALCHEMY_RUNTIME__` residue — through alchemy's REAL Worker bundling
 * path (`Bundle.build` + the Cloudflare rolldown plugin, same as
 * `WorkerLoader`). Storage worker entry included as the proven baseline
 * (storage M0: 67 KB, zero gRPC markers).
 *
 * Cases:
 *   1. fold ON  (real path) — `ALCHEMY_DEFINE` folds the runtime guard to
 *      `true`; the deploy-time branch + its gRPC graph must be DCE'd.
 *   2. fold OFF (control) — guard left `false`; shows what WOULD leak if the
 *      fold were broken (expected: gRPC + Node builtins present).
 *
 * Reported sizes: TOTAL = all chunks, ENTRY = the main script the worker
 * actually loads at startup. Lazy chunks (BunServices/NodeServices/NodeSocket,
 * the CLI tooling) are dynamic-import chunks that never load in a deployed
 * worker — inert, but they inflate the total and carry the `node:` markers.
 *
 * Usage: bun spikes/ai-bindings-bundle.ts
 */
import * as Bundle from 'alchemy/Bundle'
import * as Effect from 'effect/Effect'

const ENTRIES: Array<[string, string]> = [
  ['ai binding module only', 'spikes/min-ai-binding.ts'],
  ['storage binding module only', 'spikes/min-storage-binding.ts'],
  ['ai (raw entry)', 'examples/ai.bindings-worker.ts'],
  ['ai (virtual entry)', 'spikes/virtual-entry.ts'],
  ['storage (raw entry)', 'examples/storage.bindings-worker.ts'],
]

const MARKERS = ['@grpc', 'grpc-js', 'node:net', 'node:http2', 'node:tls', 'require("net")', '__ALCHEMY_RUNTIME__', 'host-identity', 'nebius.ai.v1']

const build = (entry: string, fold: boolean) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { default: cloudflareRolldown } = yield* Effect.promise(() =>
        import('@distilled.cloud/cloudflare-rolldown-plugin'),
      )
      return yield* Bundle.build(
        {
          input: entry,
          // Fold OFF: override alchemy's define so the guard stays `false`.
          ...(fold ? {} : { transform: { define: { 'globalThis.__ALCHEMY_RUNTIME__': 'false' } } }),
          preserveEntrySignatures: 'strict',
          external: ['lightningcss', 'fsevents'],
          plugins: [cloudflareRolldown({ compatibilityDate: '2024-09-23' })],
          checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
        },
        {
          format: 'esm',
          sourcemap: false,
          minify: true,
          keepNames: true,
          strictExecutionOrder: true,
        },
      )
    }),
  )

for (const [name, entry] of ENTRIES) {
  for (const fold of [true, false]) {
    try {
      const output = await build(entry, fold)
      const files = output.files.map((f) => f.content)
      const totalKb = (files.reduce((s, c) => s + c.length, 0) / 1024).toFixed(1)
      const entryKb = ((output.files[0]?.content.length ?? 0) / 1024).toFixed(1)
      const found = MARKERS.filter((m) => files.join('\n').includes(m))
      console.log(
        `[${name}] fold ${fold ? 'ON ' : 'OFF'} → total ${totalKb} KB | entry ${entryKb} KB | markers: ${found.length === 0 ? 'none' : found.join(', ')}`,
      )
    } catch (error) {
      console.log(`[${name}] fold ${fold ? 'ON ' : 'OFF'} → BUILD FAILED: ${String(error).slice(0, 300)}`)
    }
  }
}
