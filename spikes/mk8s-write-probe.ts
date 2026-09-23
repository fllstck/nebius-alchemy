/**
 * mk8s **write-path** probe (2026-09-23) — the two design questions the read-only
 * probe could not answer. This one creates and deletes real infrastructure.
 *
 *   1. **Is `controlPlane.subnetId` really immutable?** The CLI omits it from
 *      `cluster update`, which is strong evidence but not a refusal we have seen.
 *      Here a real `UpdateCluster` is sent with a *different, valid* subnet — so
 *      "immutable" is distinguishable from "not found".
 *   2. **Does `PreflightCheck` report `pathsRequireRecreate` for an UPDATE?** With
 *      `action: CREATE` it returned nothing at all, even for a bogus `os`. If the
 *      UPDATE form names the paths that force a recreate, it replaces the
 *      CLI-derived immutability table; if it also returns nothing, the idea is
 *      retired rather than left half-assumed.
 *
 * Cleanup is guaranteed by `Effect.ensuring`: the cluster is deleted (which
 * cascades the node group, its instances and their boot disks — measured
 * 2026-09-23) whether the body succeeds or fails.
 *
 *   bun spikes/mk8s-write-probe.ts
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

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const SERVICE_ACCOUNT_ID = 'serviceaccount-e00r4d1ae86rb4n03a'
/** The pre-existing default subnet — what the cluster is created in. */
const SUBNET_ORIGINAL = 'vpcsubnet-e00rf5t1vkbq0ew96x'
/** A second subnet, created for this probe only, to change `subnetId` *to*. */
const SUBNET_OTHER = 'vpcsubnet-e00mnmn33gafa14s40'
const CLUSTER_NAME = 'alchemy-mk8s-write-probe'
const NODE_GROUP_NAME = 'alchemy-mk8s-write-probe-ng'

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

const log = (label: string, value: unknown) =>
  console.log(`\n== ${label} ==\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)?.slice(0, 1600)}`)

const baseTemplate = (subnetId: string) => ({
  os: 'ubuntu24.04',
  resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
  networkInterfaces: [{ subnetId }],
  serviceAccountId: SERVICE_ACCOUNT_ID,
  bootDisk: { type: 1, sizeGibibytes: Long.fromNumber(64) },
  cloudInitUserData: '#cloud-config\n',
})

const template = (subnetId: string) => NodeGroupSpec.fromPartial({ template: baseTemplate(subnetId) }).template!

/** Run an UPDATE preflight and report just the fields under investigation. */
const preflight = (
  mk8s: Mk8sGrpcModule.Mk8sGrpcServiceShape,
  label: string,
  ng: { id: string; name: string; clusterId: string },
  spec: ReturnType<typeof NodeGroupSpec.fromPartial>,
) =>
  mk8s.nodeGroup
    .preflightCheck({
      context: { action: PreflightCheckContext_Action.UPDATE, tool: 'alchemy' },
      metadata: { id: ng.id, name: ng.name, parentId: ng.clusterId },
      spec,
    })
    .pipe(
      Effect.map((r) =>
        log(`preflight UPDATE — ${label}`, {
          pathsRequireRecreate: JSON.stringify(r.pathsRequireRecreate),
          requiresUserApproval: r.requiresUserApproval,
          diagnostics: r.diagnostics.map((d) => ({ severity: d.severity, summary: d.summary, path: d.path })),
        }),
      ),
      Effect.catch((e) => Effect.sync(() => log(`preflight UPDATE — ${label}`, `FAILED: ${String(e)}`))),
    )

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService

  // ── Cluster ─────────────────────────────────────────────────────────────
  const cluster = yield* mk8s.cluster.create({
    metadata: { parentId: PROJECT_ID, name: CLUSTER_NAME },
    spec: {
      controlPlane: {
        version: '1.35',
        subnetId: SUBNET_ORIGINAL,
        etcdClusterSize: Long.fromNumber(1),
      },
    },
  })
  const clusterId = cluster.metadata!.id
  log('cluster created', {
    id: clusterId,
    resourceVersion: cluster.metadata!.resourceVersion.toString(),
    spec: cluster.spec,
    state: cluster.status?.state,
    statusVersion: cluster.status?.controlPlane?.version,
  })

  yield* Effect.gen(function* () {
    // ── PROBE A: change the control-plane subnet ───────────────────────────
    log('PROBE A — attempt UpdateCluster with a DIFFERENT subnet_id', SUBNET_OTHER)
    yield* mk8s.cluster
      .update({
        metadata: { id: clusterId, resourceVersion: cluster.metadata!.resourceVersion.toString() },
        spec: { controlPlane: { subnetId: SUBNET_OTHER } },
      })
      .pipe(
        Effect.map((updated) =>
          log('PROBE A result — the update was ACCEPTED (subnetId is mutable)', {
            subnetIdNow: updated.spec?.controlPlane?.subnetId,
            resourceVersion: updated.metadata?.resourceVersion.toString(),
          }),
        ),
        Effect.catch((e) =>
          Effect.sync(() => log('PROBE A result — REJECTED (subnetId looks immutable)', String(e))),
        ),
      )

    // Re-read, so we know whether the cluster survived either outcome.
    yield* mk8s.cluster.get(clusterId).pipe(
      Effect.map((c) =>
        log('cluster after PROBE A', {
          state: c.status?.state,
          specSubnet: c.spec?.controlPlane?.subnetId,
          specVersion: c.spec?.controlPlane?.version,
        }),
      ),
      Effect.catch((e) => Effect.sync(() => log('cluster after PROBE A', `READ FAILED: ${String(e)}`))),
    )

    // ── Node group ──────────────────────────────────────────────────────────
    // Skippable: the node-group probes are answered, so a re-run that only needs
    // PROBE A can avoid paying for a VM and ~4 minutes.
    if (process.env.MK8S_SKIP_NODE_GROUP === '1') {
      log('node-group section SKIPPED (MK8S_SKIP_NODE_GROUP=1)', 'PROBE A only')
      return
    }

    const ng = yield* mk8s.nodeGroup.create({
      metadata: { parentId: clusterId, name: NODE_GROUP_NAME },
      spec: NodeGroupSpec.fromPartial({ fixedNodeCount: Long.fromNumber(1), template: baseTemplate(SUBNET_ORIGINAL) }),
    })
    const ngRef = { id: ng.metadata!.id, name: ng.metadata!.name, clusterId }
    log('node group created', {
      id: ngRef.id,
      // Only keys the server actually carried a value for. `Object.keys` alone would be
      // misleading: ts-proto's decoded message keeps every declared key, set to
      // `undefined` when the wire had no value.
      specKeysWithValues: Object.entries(ng.spec ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key),
      statusVersion: ng.status?.version,
      // Note the shapes: the api-client returns the *decoded protobuf*, so int64s are
      // `Long` objects and `Duration` is `{ seconds, nanos }` — NOT the decimal strings
      // the JSON rendering (what `toFriendlyAttributes` overlays) produces.
      strategy: ng.status?.strategy,
      nodeCount: ng.status?.nodeCount?.toString(),
    })

    // ── PROBES B–E: does an UPDATE preflight name recreate paths? ───────────
    // B: a different platform (a plausible immutable).
    yield* preflight(mk8s, 'B: template.resources.platform → cpu-e2', ngRef,
      NodeGroupSpec.fromPartial({
        fixedNodeCount: Long.fromNumber(1),
        template: { ...baseTemplate(SUBNET_ORIGINAL), resources: { platform: 'cpu-e2', preset: '2vcpu-8gb' } },
      }))
    // C: control — the identical spec, nothing should require recreation.
    yield* preflight(mk8s, 'C: identical spec (control)', ngRef,
      NodeGroupSpec.fromPartial({ fixedNodeCount: Long.fromNumber(1), template: baseTemplate(SUBNET_ORIGINAL) }))
    // D: nvlink — the one path the CLI omits from `update`.
    yield* preflight(mk8s, 'D: template.nvlink.nvlInstanceGroupId (create-only flag)', ngRef,
      NodeGroupSpec.fromPartial({
        fixedNodeCount: Long.fromNumber(1),
        template: { ...baseTemplate(SUBNET_ORIGINAL), nvlink: { nvlInstanceGroupId: 'nvlinstancegroup-probe' } },
      }))
    // E: a plainly updatable field, as a second control.
    yield* preflight(mk8s, 'E: fixedNodeCount 1 → 2 (updatable control)', ngRef,
      NodeGroupSpec.fromPartial({ fixedNodeCount: Long.fromNumber(2), template: baseTemplate(SUBNET_ORIGINAL) }))
  }).pipe(
    // Guaranteed teardown: the cluster delete cascades node groups + nodes + disks.
    Effect.ensuring(
      mk8s.cluster
        .delete(clusterId)
        .pipe(
          Effect.map(() => log('cleanup — cluster deleted (cascade)', clusterId)),
          Effect.catch((e) => Effect.sync(() => log('cleanup FAILED — delete by hand', `${clusterId}: ${String(e)}`))),
        ),
    ),
  )
})

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
