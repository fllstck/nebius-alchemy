/**
 * Read-only probe of the mk8s API + the new `modules/api-client/mk8s.ts`.
 *
 * Everything here is **read-only** — the four questions it answers cannot be
 * settled from the protos, and two of them decide code that is already written:
 *
 * 1. **Does `pageSize: 100` get accepted by both list endpoints?** The list
 *    builders shipped with `100` on the strength of this probe; `nvl-instance-group`
 *    rejects `100` while its compute neighbours accept it, so this is measured, not
 *    assumed. A node-group list needs a cluster parent, and there is none — so the
 *    signal is that the error is about the *cluster*, not the page size.
 * 2. **What does `ListControlPlaneVersions` actually contain?** (`deprecated` /
 *    `restricted` / `endOfLife` are all in the message, and 1.31 was already EOL on
 *    2026-09-01 — so a provider must not default a version.)
 * 3. **What does `GetCompatibilityMatrix` return** for a CPU platform, i.e. is
 *    `template.os` really authorable from it?
 * 4. **What does `PreflightCheck` return?** Its response carries
 *    `pathsRequireRecreate` + `diagnostics` + `requiresUserApproval`, and the request
 *    context is a *generic* Nebius facility (`tool: "terraform" | "cli" | "console"`).
 *    If it reports which paths force a recreate, it replaces a hand-written
 *    immutability table. Its semantics are unverified, which is why this runs.
 *
 *   bun spikes/mk8s-probe.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import Long from 'long'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as Mk8sGrpcModule from '../modules/api-client/mk8s.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import { NodeGroupSpec } from '../schemas/nebius/mk8s/v1/node_group.ts'
import { PreflightCheckContext_Action } from '../schemas/nebius/common/v1/preflight_check.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { Mk8sGrpcService, Mk8sGrpcServiceLive } = Mk8sGrpcModule

// Values reused from the 2026-09-23 probe session (all pre-existing, none created).
const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const SUBNET_ID = 'vpcsubnet-e00rf5t1vkbq0ew96x'
const SERVICE_ACCOUNT_ID = 'serviceaccount-e00r4d1ae86rb4n03a'

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

/** A minimal, well-formed NodeGroupSpec — the shape the provider will send. */
const probeSpec = () =>
  NodeGroupSpec.fromPartial({
    fixedNodeCount: Long.fromNumber(1),
    template: {
      os: 'ubuntu24.04',
      resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
      networkInterfaces: [{ subnetId: SUBNET_ID }],
      serviceAccountId: SERVICE_ACCOUNT_ID,
      bootDisk: { type: 1, sizeGibibytes: Long.fromNumber(64) },
      cloudInitUserData: '#cloud-config\n',
    },
  })

const show = (label: string, value: unknown) =>
  console.log(`\n== ${label} ==\n${JSON.stringify(value, null, 2)?.slice(0, 1400)}`)

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService

  // ── 1. list + pageSize, through the shipped builders ─────────────────────
  const clusters = yield* mk8s.cluster.list(PROJECT_ID)
  show('cluster.list(project) — exercises clusterListRequest (pageSize 100)', {
    count: clusters.length,
  })

  // No cluster exists, so this must fail on the *parent*, not on the page size.
  const ngList = yield* mk8s.nodeGroup
    .list('mk8scluster-doesnotexist')
    .pipe(Effect.catch((e) => Effect.succeed(`FAILED: ${String(e)}`)))
  show('nodeGroup.list(bogus cluster) — exercises nodeGroupListRequest (pageSize 100)', ngList)

  // ── 2. version catalogue ─────────────────────────────────────────────────
  const versions = yield* mk8s.cluster.listControlPlaneVersions
  show(
    'cluster.listControlPlaneVersions()',
    versions.map((v) => ({
      version: v.version,
      deprecated: v.deprecated,
      restricted: v.restricted,
      endOfLife: v.endOfLife ? v.endOfLife.toISOString().slice(0, 10) : undefined,
    })),
  )

  // ── 3. compatibility matrix (what makes template.os authorable) ──────────
  const matrix = yield* mk8s.nodeGroup.getCompatibilityMatrix({
    clusterKubernetesVersion: '1.35',
    platform: 'cpu-d3',
  })
  show('nodeGroup.getCompatibilityMatrix(1.35, cpu-d3)', matrix)

  // ── 4. PreflightCheck — the immutability oracle? ─────────────────────────
  const createCheck = yield* mk8s.nodeGroup
    .preflightCheck({
      context: { action: PreflightCheckContext_Action.CREATE, tool: 'alchemy' },
      metadata: { parentId: 'mk8scluster-doesnotexist', name: 'probe-ng' },
      spec: probeSpec(),
    })
    .pipe(Effect.catch((e) => Effect.succeed(`FAILED: ${String(e)}`)))
  show('preflightCheck(action=CREATE)', createCheck)

  // UPDATE against a non-existent node group: does it validate existence first?
  const updateCheck = yield* mk8s.nodeGroup
    .preflightCheck({
      context: { action: PreflightCheckContext_Action.UPDATE, tool: 'alchemy' },
      metadata: { id: 'mk8snodegroup-doesnotexist', name: 'probe-ng' },
      spec: probeSpec(),
    })
    .pipe(Effect.catch((e) => Effect.succeed(`FAILED: ${String(e)}`)))
  show('preflightCheck(action=UPDATE, bogus id)', updateCheck)

  // A deliberately unsupported os, to see whether diagnostics are populated.
  const badCheck = yield* mk8s.nodeGroup
    .preflightCheck({
      context: { action: PreflightCheckContext_Action.CREATE, tool: 'alchemy' },
      metadata: { parentId: 'mk8scluster-doesnotexist', name: 'probe-ng' },
      spec: NodeGroupSpec.fromPartial({
        ...probeSpec(),
        template: { ...probeSpec().template, os: 'not-a-real-os' },
      }),
    })
    .pipe(Effect.catch((e) => Effect.succeed(`FAILED: ${String(e)}`)))
  show('preflightCheck(action=CREATE, bogus os)', badCheck)
})

// Compose the graph bottom-up and provide it once: `Mk8sGrpcServiceLive` requires
// `NebiusGrpcTransport`, so the transport layer is *provided into* it (a merge
// would leave the requirement unsatisfied — and chaining `Effect.provide` calls
// breaks layer lifecycle).
const transportLayer = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)
const mk8sLayer = Mk8sGrpcServiceLive.pipe(Layer.provide(transportLayer))

try {
  await Effect.runPromise(program.pipe(Effect.provide(mk8sLayer), Effect.scoped))
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
