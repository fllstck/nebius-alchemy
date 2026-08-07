/**
 * Mechanical D8 guard backfill: wrap every unguarded `AlchemyProvider.succeed`
 * export in the `__ALCHEMY_RUNTIME__` conditional (the pattern in
 * `modules/resources/storage/v1/bucket.ts`) so Worker bundles DCE the
 * deploy-time provider graph (gRPC clients, protobuf schemas, factories).
 *
 * Usage: bun spikes/backfill-provider-guard.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'

const files = [
  'modules/resources/kms/v1/asymmetric-key.ts',
  'modules/resources/kms/v1/symmetric-key.ts',
  'modules/resources/quotas/v1/quota-allowance.ts',
  'modules/resources/storage/v1/transfer.ts',
  'modules/resources/iam/v1/group-membership.ts',
  'modules/resources/iam/v1/federation.ts',
  'modules/resources/iam/v1/invitation.ts',
  'modules/resources/iam/v1/group.ts',
  'modules/resources/iam/v1/federation-certificate.ts',
  'modules/resources/iam/v1/auth-public-key.ts',
  'modules/resources/iam/v1/federated-credentials.ts',
  'modules/resources/iam/v1/service-account.ts',
  'modules/resources/iam/v1/access-permit.ts',
  'modules/resources/iam/v1/static-key.ts',
  'modules/resources/iam/v2/project.ts',
  'modules/resources/iam/v2/access-key.ts',
  'modules/resources/compute/v1/image.ts',
  'modules/resources/compute/v1/disk-snapshot.ts',
  'modules/resources/compute/v1/filesystem.ts',
  'modules/resources/compute/v1/disk.ts',
  'modules/resources/compute/v1/instance.ts',
  'modules/resources/vpc/v1/pool.ts',
  'modules/resources/vpc/v1/allocation.ts',
  'modules/resources/vpc/v1/security-rule.ts',
  'modules/resources/vpc/v1/route-table.ts',
  'modules/resources/vpc/v1/route.ts',
  'modules/resources/vpc/v1/security-group.ts',
  'modules/resources/dns/v1/record.ts',
  'modules/resources/dns/v1/zone.ts',
  'modules/resources/mysterybox/v1/secret.ts',
  'modules/resources/mysterybox/v1/secret-version.ts',
]

const PROVIDER_RE = /^export const (Nebius\w+Provider) = AlchemyProvider\.succeed\((\w+), \{$/m

const guarded = (provider: string, type: string) =>
  `/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */\n` +
  `export const ${provider}: Layer.Layer<\n` +
  `  AlchemyProvider.Provider<${type}>,\n` +
  `  never,\n` +
  `  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)\n` +
  `  any\n` +
  `> = globalThis.__ALCHEMY_RUNTIME__\n` +
  `  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard\n` +
  `    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<${type}>, never, any>)\n` +
  `  : AlchemyProvider.succeed(${type}, {`

let changed = 0
for (const file of files) {
  let src = readFileSync(file, 'utf8')
  const original = src

  // 1. Add the Layer import after the Effect import.
  if (!src.includes("import * as Layer from 'effect/Layer'")) {
    const layerImport = "import * as Layer from 'effect/Layer'\n"
    src = src.replace("import * as Effect from 'effect/Effect'\n", `import * as Effect from 'effect/Effect'\n${layerImport}`)
  }

  // 2. Guard the provider export.
  let providerName = 'n/a'
  const match = PROVIDER_RE.exec(src)
  if (match) {
    const [, provider, type] = match
    providerName = provider ?? 'n/a'
    src = src.replace(PROVIDER_RE, guarded(provider ?? '', type ?? ''))
  }

  if (src !== original) {
    writeFileSync(file, src)
    changed += 1
    console.log(`guarded ${file} (${providerName})`)
  } else {
    console.log(`SKIP ${file} (no change — already guarded or unexpected shape)`)
  }
}
console.log(`\n${changed}/${files.length} files updated`)
