import * as Bundle from 'alchemy/Bundle'
import * as Effect from 'effect/Effect'
const output = await Effect.runPromise(
  Bundle.build(
    { input: 'spikes/tmp/entry-a.ts', checks: { unresolvedImport: false, ineffectiveDynamicImport: false } },
    { format: 'esm', sourcemap: false, minify: false },
  ),
)
for (const f of output.files) {
  if (f.content.includes('findAvailablePort') || f.content.includes('Util/Node')) {
    console.log('file has findAvailablePort:', f.path)
  }
}
console.log('total files:', output.files.length)
