/**
 * Read-only: (a) the tenant's quota allowances, (b) which node OS images each control-plane version
 * offers on `cpu-d3`.
 *
 * Two questions the mk8s notes left standing, both answerable without spending anything:
 *
 *   1. **Is GB200/B300 actually blocked on entitlement?** TASKS said "no GB200/GB300 platform in this
 *      tenant's advice (entitlement absent)", but the capacity advisor *does* advertise
 *      `gpu-b200-sxm` / `gpu-b300-sxm` rows — so the claim is at least imprecise. The quota list is the
 *      read-only half of the answer (what the tenant is allowed to consume); a create is the other half,
 *      and that one costs GB200 money.
 *   2. **`template.os`: is `ubuntu24.04` really the only choice?** The arm-3/arm-5 work noted the set
 *      depends on the Kubernetes version *and* the platform, and `1.35` + `cpu-d3` offered exactly one
 *      image — this sweeps every control-plane version to see whether any offers more (which is what a
 *      future `os`-change probe would need).
 *
 *   bun spikes/quota-and-os-matrix.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as Mk8sGrpcModule from '../modules/api-client/mk8s.ts'
import * as QuotasGrpcModule from '../modules/api-client/quotas.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as QuotaSchema from '../schemas/nebius/quotas/v1/quota_allowance.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { Mk8sGrpcService, Mk8sGrpcServiceLive } = Mk8sGrpcModule
const { QuotasGrpcService, QuotasGrpcServiceLive } = QuotasGrpcModule

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const PLATFORM = process.env.NEBIUS_PLATFORM ?? 'cpu-d3'

const authLayer = Layer.mergeAll(ProfileStoreLive, NebiusAuthModule.NebiusAuth).pipe(
  Layer.provide(CredentialsStoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      PlatformNode.NodeServices.layer,
      SaTokenModule.SaTokenMinterLive,
      SaBootstrapModule.SaBootstrapLive,
    ),
  ),
)

const program = Effect.gen(function* () {
  const quotas = yield* QuotasGrpcService
  const mk8s = yield* Mk8sGrpcService

  // ── (a) quota allowances ──────────────────────────────────────────────────
  const allowances = yield* quotas.quotaAllowance.list(PROJECT_ID)
  console.log(`\nquota allowances: ${allowances.length}`)
  // One raw row first: `spec.limit` came back `undefined` for all 61 in the first run, so the field
  // must be read from wherever the API actually puts it rather than assumed.
  console.log('\nfirst row, verbatim:', JSON.stringify(QuotaSchema.QuotaAllowance.toJSON(allowances[0]), null, 2))
  const gpuIsh = /gpu|b200|b300|h100|h200|l40|rtx|infini/i
  for (const allowance of allowances) {
    const name = allowance.metadata?.name ?? '?'
    const marker = gpuIsh.test(name) ? '  ← GPU-ish' : ''
    console.log(
      `  ${name}  region=${allowance.spec?.region ?? '?'} limit=${allowance.spec?.limit?.toString() ?? '?'} ` +
        `usage=${allowance.status?.usage?.toString() ?? '?'} state=${allowance.status?.state ?? '?'}${marker}`,
    )
  }

  // ── (b) node OS images per control-plane version, on this platform ────────
  const cpVersions = yield* mk8s.cluster.listControlPlaneVersions
  console.log(`\nnode compatibility matrix on ${PLATFORM}, per control-plane version:`)
  for (const cp of cpVersions) {
    const flags = [cp.restricted ? 'RESTRICTED' : null, cp.deprecated ? 'DEPRECATED' : null, cp.endOfLife ? `EOL ${cp.endOfLife.toISOString?.() ?? cp.endOfLife}` : null]
      .filter((flag) => flag !== null)
      .join(' ')
    console.log(`  cp ${cp.version}${flags === '' ? '' : ` (${flags})`}`)
    const matrix = yield* mk8s.nodeGroup
      .getCompatibilityMatrix({ clusterKubernetesVersion: cp.version, platform: PLATFORM })
      .pipe(Effect.catch((error) => Effect.sync(() => `ERROR ${String(error)}`)))
    if (typeof matrix === 'string') {
      console.log(`  cp ${cp.version}: ${matrix}`)
      continue
    }
    for (const version of matrix.versions) {
      console.log(
        `  cp ${cp.version} → node ${version.kubernetesVersion}: ` +
          version.items
            .map(
              (item) =>
                `${item.os}${item.driversPreset === '' ? '' : `/${item.driversPreset}`}` +
                `${item.compatiblePlatforms.length > 0 ? `[${item.compatiblePlatforms.join(',')}]` : ''}`,
            )
            .join(', '),
      )
    }
    if (matrix.versions.length === 0) console.log(`  cp ${cp.version} → (no node versions offered)`)
  }
})

const layer = Layer.mergeAll(Mk8sGrpcServiceLive, QuotasGrpcServiceLive).pipe(
  Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
