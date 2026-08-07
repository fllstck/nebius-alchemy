/**
 * Bisect: which AI/VPC resource module retains gRPC in a worker bundle?
 * (Storage's bucket module tree-shakes its provider + gRPC; the AI worker
 * entry does not — find the culprit.)
 */
import * as Bundle from 'alchemy/Bundle'
import * as Effect from 'effect/Effect'

const CASES: Array<[string, string]> = [
  ['endpoint', "import { NebiusEndpoint } from '../modules/resources/ai/v1/endpoint.ts'\nexport const x = NebiusEndpoint"],
  ['network', "import { NebiusNetwork } from '../modules/resources/vpc/v1/network.ts'\nexport const x = NebiusNetwork"],
  ['subnet', "import { NebiusSubnet } from '../modules/resources/vpc/v1/subnet.ts'\nexport const x = NebiusSubnet"],
  ['job', "import { NebiusJob } from '../modules/resources/ai/v1/job.ts'\nexport const x = NebiusJob"],
  ['bucket', "import { NebiusBucket } from '../modules/resources/storage/v1/bucket.ts'\nexport const x = NebiusBucket"],
]

for (const [name, source] of CASES) {
  const { writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const file = join(process.cwd(), 'spikes', 'tmp-bisect.ts')
  writeFileSync(file, source)
  try {
    const output = await Effect.runPromise(
      Bundle.build(
        { input: file, checks: { unresolvedImport: false, ineffectiveDynamicImport: false } },
        { format: 'esm', sourcemap: false, minify: true },
      ),
    )
    const files = output.files.map((f) => f.content)
    const entryKb = ((output.files[0]?.content.length ?? 0) / 1024).toFixed(0)
    const totalKb = (files.reduce((s, c) => s + c.length, 0) / 1024).toFixed(0)
    const grpc = files.join('\n').includes('@grpc')
    console.log(`${name.padEnd(9)}: ${grpc ? 'gRPC PRESENT' : 'no gRPC     '} | entry ${entryKb} KB | total ${totalKb} KB`)
  } catch (error) {
    console.log(`${name.padEnd(9)}: BUILD FAILED ${String(error).slice(0, 100)}`)
  }
  rmSync(file, { force: true })
}
