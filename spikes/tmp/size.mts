import * as Bundle from 'alchemy/Bundle'
import * as Effect from 'effect/Effect'
const entry = process.argv[2]
const output = await Effect.runPromise(
  Bundle.build(
    { input: entry, checks: { unresolvedImport: false, ineffectiveDynamicImport: false } },
    { format: 'esm', sourcemap: false, minify: true },
  ),
)
const all = output.files.map((f) => f.content).join('\n')
const kb = (all.length / 1024).toFixed(1)
const markers = ['node:net', 'node:http2', 'node:tls', 'node:os', 'node:crypto', 'node:child_process', 'node:fs'].filter((m) => all.includes(m))
console.log(`${entry}: ${kb} KB | markers: ${markers.length ? markers.join(', ') : 'none'}`)
