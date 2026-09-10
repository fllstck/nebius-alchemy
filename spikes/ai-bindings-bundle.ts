/**
 * AD8 bundle-safety spike (M4 follow-up): prove the AI bindings worker entry
 * bundles clean — zero gRPC markers, no Node-only builtins, no
 * `__ALCHEMY_RUNTIME__` residue — through alchemy's REAL Worker bundling
 * path (`Bundle.build` + the Cloudflare rolldown plugin, same as
 * `Cloudflare/Workers/Sources/Rolldown.ts`). Storage worker entry included as
 * the proven baseline (storage M0: 67 KB, zero gRPC markers).
 *
 * The Cloudflare rolldown plugin moved in-house in alchemy beta.77: it used to
 * be the `alchemy` dependency `@distilled.cloud/cloudflare-rolldown-plugin`,
 * and is now `@alchemy.run/cloudflare-runtime/rolldown` — the exact specifier
 * alchemy itself imports. Importing the old name still "worked" locally only
 * because a pre-upgrade copy lingered in `node_modules`; a clean install fails
 * with TS2307. Keep this in sync with alchemy's own call site, which it mirrors
 * option-for-option (including `plugins: [cloudflareRolldown({...})]` — the
 * plugin returns an ARRAY of plugins, nested here exactly as alchemy nests it).
 *
 * Cases:
 *   1. fold ON  (real path) — `ALCHEMY_DEFINE` folds the runtime guard to
 *      `true`; the deploy-time branch + its gRPC graph must be DCE'd.
 *   2. fold OFF (control) — ⚠️ INERT, DO NOT TRUST THE A/B. `Bundle.build`
 *      merges the caller's `transform.define` UNDER `ALCHEMY_DEFINE`
 *      ("framework flags win over any caller-provided keys"), so the caller's
 *      `false` is always overridden with `true`. Both rows of the report are
 *      therefore the fold-ON path and are byte-identical by construction.
 *      Verified identical in alchemy beta.70 and beta.77, so this control has
 *      never worked; a real control needs a different mechanism (see the
 *      bundle-safety task in TASKS.md).
 *
 * ⚠️ Post-beta.77 measurements are NOT comparable to the M4 figures recorded in
 * AI_BINDINGS.md: the AI example entries now report ~884/917 KB entries with
 * `@grpc` / `grpc-js` / `nebius.ai.v1` markers where M4 recorded ~115/145 KB and
 * no gRPC markers. Not yet explained — could be a real guard regression under
 * beta.77's in-house bundler, or this harness no longer mirroring alchemy's real
 * options (it omits `compatibilityFlags`, the virtual-entry plugin, and
 * `extraOptions`). Investigate before drawing conclusions.
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
        import('@alchemy.run/cloudflare-runtime/rolldown'),
      )
      return yield* Bundle.build(
        {
          input: entry,
          // Fold OFF (inert — see the docblock): the caller's define loses to
          // alchemy's ALCHEMY_DEFINE, so this changes nothing. Kept only so the
          // intent is visible when the control is reimplemented properly.
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
