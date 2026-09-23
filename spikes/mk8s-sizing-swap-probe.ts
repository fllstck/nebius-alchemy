/**
 * mk8s **sizing-swap / update-semantics** probe (2026-09-23).
 *
 * Two questions, one run, because both are answered by the same updates:
 *
 *   1. **Does switching `fixedNodeCount` ⇄ `autoscaling` clear the other side?** There is no
 *      `FieldMask` on `UpdateNodeGroupRequest` (only `{metadata, spec}`), so the provider's `diff`
 *      plans an *in-place* update for the swap. If the API keeps both fields, the group would carry a
 *      stale sizing — and the swap should be planned as a replace instead.
 *   2. **What do absent fields mean on an update at all?** The provider has been assuming "leave
 *      unchanged" (`AGENTS.md` §"mk8s has no `FieldMask`"), and that assumption is an **inference**
 *      from the missing mask, never measured. The CLI is what makes it doubtful: its `update` has
 *      `--patch`, `--diff` and `--clear-mask` ("Reset-mask field paths to clear in patch mode"),
 *      i.e. patch mode is *client-side read-modify-write* — which only makes sense if a sent spec is
 *      the **full desired state** (absent ⇒ reset to the platform default).
 *
 * The probe therefore sets a value, then sends a spec that *omits* it, and reads `spec` back:
 *
 *   - `strategy.drainTimeoutSeconds: 900` on create, omitted in update A
 *   - `fixedNodeCount: 1` on create, `autoscaling` only in update A
 *   - `autoscaling` in update A, `fixedNodeCount` only in update B (the reverse swap)
 *
 * Reading an **echo** is the whole point, so every step prints the full `spec` JSON (Longs as
 * decimal strings, enums as names) plus `status.strategy`, which is where the API reports the
 * *effective* values.
 *
 * Cleanup is guaranteed by `Effect.ensuring`: the cluster is deleted (which cascades the node group,
 * its instances and their boot disks — measured 2026-09-23) whether the body succeeds or fails.
 *
 *   bun spikes/mk8s-sizing-swap-probe.ts
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
import * as NodeGroupSchema from '../schemas/nebius/mk8s/v1/node_group.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { Mk8sGrpcService, Mk8sGrpcServiceLive } = Mk8sGrpcModule
const { NodeGroupSpec } = NodeGroupSchema

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const SERVICE_ACCOUNT_ID = process.env.NEBIUS_SA_ID ?? 'serviceaccount-e00r4d1ae86rb4n03a'
/** The pre-existing default subnet (the probe-only second subnet was deleted after the 2026-09-23 run). */
const SUBNET_ID = process.env.NEBIUS_SUBNET_ID ?? 'vpcsubnet-e00rf5t1vkbq0ew96x'
const CLUSTER_NAME = 'alchemy-mk8s-swap-probe'
const NODE_GROUP_NAME = 'alchemy-mk8s-swap-probe-ng'

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

/** The full spec JSON — Longs as decimal strings, enums as names. */
const specJson = (spec: NodeGroupSchema.NodeGroupSpec | undefined): unknown =>
  spec === undefined ? null : NodeGroupSchema.NodeGroupSpec.toJSON(spec)

const log = (label: string, value: unknown) =>
  console.log(`\n== ${label} ==\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

/** What one state of the group looks like: the two sizing fields and the strategy, in the echo. */
const report = (label: string, ng: NodeGroupSchema.NodeGroup) => {
  const spec = ng.spec
  console.log(
    `\n── ${label} ──` +
      `\n  spec.fixedNodeCount  = ${spec?.fixedNodeCount === undefined ? '(absent)' : spec.fixedNodeCount.toString()}` +
      `\n  spec.autoscaling     = ${spec?.autoscaling === undefined ? '(absent)' : JSON.stringify(NodeGroupSchema.NodeGroupAutoscalingSpec.toJSON(spec.autoscaling))}` +
      `\n  spec.strategy        = ${spec?.strategy === undefined ? '(absent)' : JSON.stringify(NodeGroupSchema.NodeGroupDeploymentStrategy.toJSON(spec.strategy))}` +
      `\n  status.strategy      = ${ng.status?.strategy === undefined ? '(absent)' : JSON.stringify(NodeGroupSchema.NodeGroupDeploymentStrategy.toJSON(ng.status.strategy))}` +
      `\n  status counts        = target=${ng.status?.targetNodeCount?.toString()} node=${ng.status?.nodeCount?.toString()} ready=${ng.status?.readyNodeCount?.toString()}` +
      `\n  state / resourceVer  = ${ng.status?.state} / ${ng.metadata?.resourceVersion?.toString()}`,
  )
  return {
    fixedNodeCount: spec?.fixedNodeCount?.toString() ?? null,
    autoscaling: spec?.autoscaling === undefined ? null : true,
    strategy: spec?.strategy === undefined ? null : true,
  }
}

/** The template every step sends in full (a spec without it would be a different experiment). */
const baseTemplate = {
  os: 'ubuntu24.04',
  resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
  networkInterfaces: [{ subnetId: SUBNET_ID }],
  serviceAccountId: SERVICE_ACCOUNT_ID,
  bootDisk: { type: 1, sizeGibibytes: Long.fromNumber(64) },
  cloudInitUserData: '#cloud-config\n',
}

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService

  const cluster = yield* mk8s.cluster.create({
    metadata: { parentId: PROJECT_ID, name: CLUSTER_NAME },
    spec: {
      controlPlane: {
        version: '1.35',
        subnetId: SUBNET_ID,
        etcdClusterSize: Long.fromNumber(1),
      },
    },
  })
  const clusterId = cluster.metadata!.id
  console.log(`cluster created: ${clusterId}`)

  yield* Effect.gen(function* () {
    // ── Create: a fixed size AND a pinned drain timeout (both get dropped later) ──
    let ng = yield* mk8s.nodeGroup.create({
      metadata: { parentId: clusterId, name: NODE_GROUP_NAME },
      spec: NodeGroupSpec.fromPartial({
        fixedNodeCount: Long.fromNumber(1),
        // Pinned on purpose: update A omits `strategy` entirely, so the echo answers whether an
        // absent message is "leave unchanged" or "reset to the platform defaults".
        strategy: { drainTimeout: { seconds: Long.fromNumber(900) } },
        template: baseTemplate,
      }),
    })
    const ngId = ng.metadata!.id
    const created = report('AFTER CREATE (fixedNodeCount=1, strategy.drainTimeout=900)', ng)

    const update = (label: string, payload: () => ReturnType<typeof NodeGroupSpec.fromPartial>) =>
      Effect.gen(function* () {
        // **Re-read first.** The create's `resourceVersion` is stale the moment an update lands, and a
        // stale token is rejected with `9 FAILED_PRECONDITION: resource_version mismatch` — which is
        // exactly what the first run of this probe did to arm B. On a throwaway probe that is a
        // wasted run, so this is also the reason `reconcile` reads the live resource before updating.
        const before = yield* mk8s.nodeGroup.get(ngId)
        return yield* mk8s.nodeGroup
          .update({
            metadata: { id: ngId, resourceVersion: before.metadata!.resourceVersion.toString() },
            spec: payload(),
          })
          .pipe(
            Effect.tap((updated) => Effect.sync(() => report(`${label} — ACCEPTED`, updated))),
            Effect.catch((error) => Effect.sync(() => log(`${label} — REJECTED`, String(error)))),
            Effect.flatMap(() => mk8s.nodeGroup.get(ngId)),
            Effect.tap((fresh) => Effect.sync(() => report(`${label} — after`, fresh))),
          )
      })

    /** The sizing field(s) the live spec currently carries — so an arm never clears them by accident. */
    const currentSizing = (spec: NodeGroupSchema.NodeGroupSpec | undefined) => ({
      ...(spec?.autoscaling !== undefined
        ? {
            autoscaling: {
              minNodeCount: spec.autoscaling.minNodeCount,
              maxNodeCount: spec.autoscaling.maxNodeCount,
            },
          }
        : {}),
      ...(spec?.fixedNodeCount !== undefined ? { fixedNodeCount: spec.fixedNodeCount } : {}),
    })

    // ── UPDATE A: the swap our provider plans today — autoscaling only ──
    // Exactly the payload `desiredSpec` builds for `{autoscaling: {1,1}}`: `fromPartial` leaves
    // `fixedNodeCount` undefined, so it is absent from the wire, and `strategy` is not sent at all.
    yield* update('UPDATE A (autoscaling only, no strategy)', () =>
      NodeGroupSpec.fromPartial({
        autoscaling: { minNodeCount: Long.fromNumber(1), maxNodeCount: Long.fromNumber(1) },
        template: baseTemplate,
      }),
    )

    // ── UPDATE B: the reverse swap — fixedNodeCount only ──
    yield* update('UPDATE B (fixedNodeCount only, no autoscaling)', () =>
      NodeGroupSpec.fromPartial({
        fixedNodeCount: Long.fromNumber(1),
        template: baseTemplate,
      }),
    )

    // ── UPDATE C: a PARTIAL strategy message — does it merge or replace? ──
    // The create pinned `strategy.drainTimeout = 900` and nothing else. If this update (which sets
    // only `maxUnavailable`) preserves `drainTimeout`, the API merges into the message — which is what
    // the provider's per-field pinning assumes when a user pins one strategy field and not the others.
    yield* update('UPDATE C (strategy.maxUnavailable only)', () => {
      const spec = ng.spec
      return NodeGroupSpec.fromPartial({
        ...currentSizing(spec),
        strategy: { maxUnavailable: { count: Long.fromNumber(2) } },
        template: baseTemplate,
      })
    })

    // ── The full echo of the last state, for the record ──
    ng = yield* mk8s.nodeGroup.get(ngId)
    log('FINAL spec echo (full JSON)', specJson(ng.spec))
    console.log(
      `\nSUMMARY create=${JSON.stringify(created)}` +
        `\n  A: autoscaling-only payload (no fixedNodeCount, no strategy)` +
        `\n  B: fixedNodeCount-only payload (no autoscaling, no strategy)` +
        `\n  C: a partial strategy message (maxUnavailable only)` +
        `\n  → a field that survives an update that omitted it means "leave unchanged";` +
        `\n    a field that resets to its default means a sent spec is the full desired state.`,
    )
  }).pipe(
    // Guaranteed teardown: the cluster delete cascades node groups + instances + their disks.
    Effect.ensuring(
      mk8s.cluster
        .delete(clusterId)
        .pipe(
          Effect.map(() => console.log(`\ncleanup — cluster deleted (cascade): ${clusterId}`)),
          Effect.catch((error) =>
            Effect.sync(() => console.error(`cleanup FAILED — delete the cluster by hand: ${clusterId}: ${String(error)}`)),
          ),
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
