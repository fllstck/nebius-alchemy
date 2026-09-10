/**
 * D8 bundle-safety harness: what does a bundled runtime program actually ship?
 *
 * The guarantee under test (D8): a deploy-to-cloud bundle must NOT carry the
 * deploy toolchain — the gRPC api-clients, IAM/proto schemas, rolldown, vite,
 * postcss. Every resource module guards its provider with
 * `globalThis.__ALCHEMY_RUNTIME__ ? undefined : …`, so the deploy bodies fold
 * away at bundle time. This harness is the only thing that checks that claim
 * end-to-end, so it must mirror alchemy's REAL Worker bundling path
 * option-for-option (`Cloudflare/Workers/Sources/Rolldown.ts` — the ground
 * truth): same plugin (incl. the builtin-plugin rebind), same compatibility
 * (from `getCompatibility`), same `cwd` resolution, same externals, checks and
 * output options, plus each entry's own `build` prop as `extraOptions`.
 *
 * WHY THE GUARD CAN LEAK (found 2026-09-10): folding the provider only removes
 * code INSIDE the provider. A module-scope helper that references a gRPC
 * service — `const waitUntilRunning = Effect.fn(…)(function* () { const c =
 * yield* AiGrpc.AiGrpcService … })` — is a top-level call that rolldown keeps
 * (calls are assumed impure), and the retained closure drags the whole gRPC
 * graph in. `endpoint.ts`, `instance.ts` and `access-key.ts` had exactly that;
 * annotating those declarations with `@__PURE__` made them droppable again.
 * Measured effect on the AI example entry: 884 KB with `@grpc`/`grpc-js`/
 * `nebius.ai.v1` markers → 139 KB with none.
 *
 * THE A/B: `real` uses `Bundle.build` (which merges `ALCHEMY_DEFINE`, so the
 * guard folds to `true`). `control` calls rolldown DIRECTLY with the same
 * options and an explicit `define` — the only way to build the unfoldable
 * variant, since `Bundle.build` lets framework flags win over caller keys. The
 * control pair (ON vs OFF) is what isolates the guard's effect: markers present
 * when unfolded that disappear once folded. `real` and `control ON` must AGREE
 * ON MARKERS (that is the fidelity check); their KB totals differ by
 * construction, because `Bundle.build` post-processes what raw rolldown
 * `generate` returns.
 *
 * Reading the numbers: TOTAL = all chunks, ENTRY = the script startup loads.
 * Lazy dynamic-import chunks (CLI tooling, effect Socket/ws, `node:*` shims)
 * inflate the total but never load in a deployed worker.
 *
 * Usage: bun spikes/ai-bindings-bundle.ts
 */
import * as Bundle from 'alchemy/Bundle'
import * as Effect from 'effect/Effect'
import * as Path from 'effect/Path'
import { NodeFileSystem } from '@effect/platform-node'
import { rolldown } from 'rolldown'
import { DEFAULT_COMPATIBILITY_DATE } from '@alchemy.run/cloudflare-runtime/core/internal/constants'

/**
 * Mirrors `getCompatibility` for a JS, non-external Worker with no user flags:
 * with the current default date `nodejs_compat` is implied by the date (so no
 * flag is emitted) and `handle_cross_request_promise_resolution` is default-on.
 * See `Cloudflare/Workers/Compatibility.ts`.
 */
const COMPATIBILITY = { date: DEFAULT_COMPATIBILITY_DATE as string, flags: [] as string[] }

/**
 * `BundleExtraOptions` plus the Worker-level extras alchemy's own bundler accepts
 * (`Cloudflare/Workers/Sources/Rolldown.ts` `WorkerBuildOptions`): an
owner `output` override and `preserveEntrySignatures`. The generic `Bundle.build`
 * type doesn't list them, alchemy's Worker path passes them through anyway.
 */
type ExtraOptions = Bundle.BundleExtraOptions & {
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  preserveEntrySignatures?: unknown
}

/** `main` + whether alchemy wraps it in the Effect virtual entry (non-external). */
type Entry = { name: string; path: string; kind: 'external' | 'effect'; extraOptions?: ExtraOptions }

const ENTRIES: Entry[] = [
  { name: 'ai binding module only', path: 'spikes/min-ai-binding.ts', kind: 'external' },
  { name: 'storage binding module only', path: 'spikes/min-storage-binding.ts', kind: 'external' },
  { name: 'ai (raw entry)', path: 'examples/ai.bindings-worker.ts', kind: 'external', extraOptions: { output: { minify: true } } },
  { name: 'ai (virtual entry)', path: 'examples/ai.bindings-worker.ts', kind: 'effect', extraOptions: { output: { minify: true } } },
  { name: 'storage (raw entry)', path: 'examples/storage.bindings-worker.ts', kind: 'external', extraOptions: { output: { minify: true } } },
]

const MARKERS = [
  '@grpc',
  'grpc-js',
  'node:net',
  'node:http2',
  'node:tls',
  'require("net")',
  '__ALCHEMY_RUNTIME__',
  'host-identity',
  'nebius.ai.v1',
]

/**
 * The Effect virtual entry, mirroring `makeEffectVirtualEntry` for a Worker with
 * no Durable Object / Workflow classes (`Cloudflare/Workers/Sources/Rolldown.ts`).
 * Replaces the earlier `spikes/virtual-entry.ts` stand-in, which was NOT what
 * alchemy injects.
 */
const virtualEntry =
  (stack: { name: string; stage: string }) =>
  (importPath: string) => `
import { env, WorkerEntrypoint } from "cloudflare:workers";
import { makeWorkerBridge } from "alchemy/Cloudflare";
import entrypoint from ${JSON.stringify(importPath)};

const meta = {
  entrypoint,
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
};

export default makeWorkerBridge(WorkerEntrypoint, meta);
`

/**
 * Rebuild any `builtin:esm-external-require` plugin with OUR rolldown copy —
 * copied from `Rolldown.ts` (see its comment): a plugin instance built by a
 * different rolldown copy fails the `instanceof` check and is silently treated
 * as a hookless JS plugin (#880).
 */
const rebindEsmExternalRequirePlugin = (
  plugins: Array<unknown>,
  esmExternalRequirePlugin: (options: unknown) => unknown,
): Array<unknown> =>
  plugins.map((plugin) => {
    if (
      typeof plugin === 'object' &&
      plugin !== null &&
      'name' in plugin &&
      (plugin as { name: string }).name === 'builtin:esm-external-require' &&
      '_options' in plugin
    ) {
      return esmExternalRequirePlugin((plugin as { _options: unknown })._options)
    }
    return plugin
  })

type BuildResult = { totalKb: number; entryKb: number; markers: string[] }

/** `BundleFile.content` is `string | Uint8Array` — normalize before scanning. */
const asText = (content: string | Uint8Array): string =>
  typeof content === 'string' ? content : new TextDecoder().decode(content)

const measure = (files: ReadonlyArray<{ path: string; content: string | Uint8Array }>): BuildResult => {
  const all = files.map((f) => asText(f.content)).join('\n')
  return {
    totalKb: Number((all.length / 1024).toFixed(1)),
    entryKb: Number((asText(files[0]?.content ?? '').length / 1024).toFixed(1)),
    markers: MARKERS.filter((m) => all.includes(m)),
  }
}

/** `resolveMainPath`/`findCwdForBundle`/`virtualEntryPlugin` are file-system Effects. */
// oxlint-disable-next-line no-explicit-any — alchemy's Bundle helpers carry DCE-erased requirements
const runFs = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(Path.layer)) as Effect.Effect<A, E, never>,
  )

const inputOptionsFor = async (
  entry: Entry,
  mode: 'real' | 'control',
  define: Record<string, string> | undefined,
) => {
  const [{ default: cloudflareRolldown }, { esmExternalRequirePlugin }] = await Promise.all([
    import('@alchemy.run/cloudflare-runtime/rolldown'),
    import('rolldown/plugins'),
  ])
  const realMain = await runFs(Bundle.resolveMainPath(entry.path))
  const cwd = await runFs(Bundle.findCwdForBundle(realMain))
  const virtualEntryPlugin = await runFs(Bundle.virtualEntryPlugin)

  return {
    input: realMain,
    cwd,
    // Alchemy passes the caller's value straight through (undefined by default).
    preserveEntrySignatures: entry.extraOptions?.preserveEntrySignatures,
    external: ['lightningcss', 'fsevents'],
    ...(mode === 'control' ? { transform: { define } } : {}),
    plugins: [
      rebindEsmExternalRequirePlugin(
        cloudflareRolldown({
          compatibilityDate: COMPATIBILITY.date,
          compatibilityFlags: COMPATIBILITY.flags,
        }) as Array<unknown>,
        esmExternalRequirePlugin as unknown as (options: unknown) => unknown,
      ),
      entry.kind === 'effect'
        ? [virtualEntryPlugin(virtualEntry({ name: 'AiBindings', stage: 'live_harness' }))]
        : undefined,
    ],
    checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
  } as Parameters<typeof Bundle.build>[0]
}

const outputOptionsFor = (entry: Entry) =>
  ({
    format: 'esm',
    // Alchemy defaults to `sourcemap: 'hidden'`. Measure CODE only: the real path
    // carries the map alongside the file, and scanning it would both inflate the
    // totals and produce false marker hits (every DROPPED module's original
    // source text appears in the map — e.g. `grpc-js` in a clean bundle).
    sourcemap: false,
    minify: true,
    keepNames: true,
    strictExecutionOrder: true,
    ...entry.extraOptions?.output,
  }) as Parameters<typeof Bundle.build>[1]

/** The real path: `Bundle.build` (framework `ALCHEMY_DEFINE` wins). */
const buildReal = async (entry: Entry): Promise<BuildResult> => {
  const inputOptions = await inputOptionsFor(entry, 'real', undefined)
  const { files } = await runFs(
    Bundle.build(inputOptions, outputOptionsFor(entry), entry.extraOptions as Bundle.BundleExtraOptions),
  )
  return measure(files)
}

/**
 * The control: rolldown directly with an explicit define, so the guard can be
 * built BOTH ways (impossible through `Bundle.build`).
 */
const buildControl = async (entry: Entry, folded: boolean): Promise<BuildResult> => {
  const inputOptions = await inputOptionsFor(entry, 'control', {
    'globalThis.__ALCHEMY_RUNTIME__': folded ? 'true' : 'false',
  })
  const bundle = await rolldown({ ...inputOptions, ...(entry.extraOptions?.input ?? {}) })
  try {
    const { output } = await bundle.generate(outputOptionsFor(entry))
    const files = output
      .filter((chunk) => chunk.type === 'chunk')
      .map((chunk) => ({ path: chunk.fileName, content: chunk.code }))
    return measure(files)
  } finally {
    await bundle.close()
  }
}

const row = (label: string, r: BuildResult) =>
  `  ${label.padEnd(14)} total ${r.totalKb.toFixed(1).padStart(8)} KB | entry ${r.entryKb.toFixed(1).padStart(7)} KB | markers: ${r.markers.length === 0 ? 'none' : r.markers.join(', ')}`

for (const entry of ENTRIES) {
  console.log(`[${entry.name}] (${entry.path}, ${entry.kind})`)
  try {
    const [real, controlOn, controlOff] = await Promise.all([
      buildReal(entry),
      buildControl(entry, true),
      buildControl(entry, false),
    ])
    console.log(row('real', real))
    console.log(row('control ON', controlOn))
    console.log(row('control OFF', controlOff))
    // Fidelity check: the control must AGREE on markers (what the D8 claim is
    // about). Sizes differ by construction — `Bundle.build` post-processes
    // (moduleTypes, dce default, file merging) where the control calls rolldown's
    // `generate` directly — so a KB delta alone is informational.
    if (real.markers.join() !== controlOn.markers.join()) {
      console.log(
        `  ⚠️ fidelity: markers differ from the control (real: ${real.markers.join(', ') || 'none'}) — options drift from Rolldown.ts`,
      )
    }
    // What the fold actually removes: markers present when the guard is NOT
    // folded away (control OFF) that disappear once it is (control ON) — same
    // toolchain, only the define differs, so this isolates the guard's effect.
    const dropped = controlOff.markers.filter((m) => !controlOn.markers.includes(m))
    console.log(
      `  → guard removes: ${dropped.length === 0 ? '(none — this module carries no deploy-graph markers even unfolded)' : dropped.join(', ')}`,
    )
  } catch (error) {
    console.log(`  BUILD FAILED: ${String(error).slice(0, 300)}`)
  }
}
