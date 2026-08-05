/**
 * M0 spike — D8 bundle experiment.
 *
 * Runs alchemy's own `Bundle.build` (same rolldown pipeline the Worker
 * provider uses: withAlchemyDefine folds `globalThis.__ALCHEMY_RUNTIME__`
 * to `true`, minify defaults to dce-only) against two entries:
 *
 *   Case A (D8 design):   guarded dynamic `await import('./fake-identity.ts')`
 *                         where fake-identity statically imports @grpc/grpc-js
 *   Case B (naive):       static import of the same gRPC module
 *
 * Then greps the emitted bundle(s) for gRPC/Node-builtin evidence.
 */
import * as path from 'node:path'
import * as Effect from 'effect/Effect'
import { build } from 'alchemy/Bundle'

const INPUT = (entry: string) => ({
  input: path.resolve(entry),
  cwd: process.cwd(),
  // Mirrors WorkerBundle.ts — rolldown resolves before tree-shaking, so these
  // would otherwise trip [UNRESOLVED_IMPORT].
  external: ['lightningcss', 'fsevents'],
})

const OUTPUT = (name: string) => ({
  format: 'esm' as const,
  dir: `spikes/worker-bundle/out/${name}`,
  minify: 'dce-only' as const,
  strictExecutionOrder: true,
})

const MARKERS = ['grpc', 'http2', 'net', 'tls', 'fake-identity', 'makeIdentity', '__ALCHEMY_RUNTIME__'] as const

const analyze = (name: string, files: ReadonlyArray<{ path?: string; content?: string | Uint8Array }>) => {
  console.log(`\n=== ${name} ===`)
  for (const f of files) {
    const content = typeof f.content === 'string' ? f.content : new TextDecoder().decode(f.content ?? new Uint8Array())
    const hits = MARKERS.filter((m) => content.includes(m))
    console.log(
      `  ${f.path ?? '?'} (${(content.length / 1024).toFixed(1)} KB)  gRPC/builtin markers: ${
        hits.length ? hits.join(', ') : 'NONE'
      }`,
    )
  }
}

try {
  console.log('--- Case A: guarded dynamic import (D8 design) ---')
  const a = await Effect.runPromise(build(INPUT('spikes/worker-bundle/entry-dynamic.ts'), OUTPUT('a-dynamic-guarded')))
  analyze('Case A', a.files)

  console.log('\n--- Case B: static import (naive control) ---')
  const b = await Effect.runPromise(build(INPUT('spikes/worker-bundle/entry-static.ts'), OUTPUT('b-static')))
  analyze('Case B', b.files)

  console.log('\nRESULT:')
  console.log('Case A (guarded dynamic import): D8 design. If markers are NONE, the gRPC module is fully excluded from the Worker bundle.')
  console.log('Case B (static import): naive control. Expect gRPC present (or build failure).')
} catch (e) {
  console.error('\nBUILD FAILED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
}
