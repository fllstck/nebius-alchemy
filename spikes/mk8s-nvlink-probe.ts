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
const CLUSTER_NAME = 'alchemy-mk8s-nvlink-probe'
const NODE_GROUP_NAME = 'alchemy-mk8s-nvlink-probe-ng'

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

// ─────────────────────────────────────────────────────────────────────────────
// The payloads below are the probe proper; everything above is the auth/transport
// wiring copied from `mk8s-sizing-swap-probe.ts` (same layer recipe, same env overrides).
// ─────────────────────────────────────────────────────────────────────────────

type NodeGroup = NodeGroupSchema.NodeGroup

/** Where a field's absence is read: the echo. */
const echoOf = (ng: NodeGroup) => ({
  nvlink: ng.spec?.template?.nvlink?.nvlInstanceGroupId ?? null,
  taints: (ng.spec?.template?.taints ?? []).map((taint) => `${taint.key}=${taint.value}:${taint.effect}`),
  os: ng.spec?.template?.os ?? null,
  // The API's effective view of the roll-out, which is how a template change shows up.
  outdated: ng.status?.outdatedNodeCount?.toString() ?? null,
  nodes: `${ng.status?.targetNodeCount?.toString()}/${ng.status?.nodeCount?.toString()}`,
  state: ng.status?.state,
  resourceVersion: ng.metadata?.resourceVersion?.toString(),
})

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService

  const cluster = yield* mk8s.cluster.create({
    metadata: { parentId: PROJECT_ID, name: CLUSTER_NAME },
    spec: {
      controlPlane: { version: '1.35', subnetId: SUBNET_ID, etcdClusterSize: Long.fromNumber(1) },
    },
  })
  const clusterId = cluster.metadata!.id
  console.log(`cluster created: ${clusterId}`)

  yield* Effect.gen(function* () {
    const created = yield* mk8s.nodeGroup.create({
      metadata: { parentId: clusterId, name: NODE_GROUP_NAME },
      spec: NodeGroupSpec.fromPartial({
        fixedNodeCount: Long.fromNumber(1),
        // Pinned so arm B can ask whether an omitted *template* field survives (the message-merge
        // question the sizing probe answered for `strategy`, now asked one level deeper).
        template: { ...baseTemplate, taints: [{ key: 'alchemy-probe', value: 'yes', effect: 1 }] },
      }),
    })
    const ngId = created.metadata!.id
    console.log(`\n== AFTER CREATE ==\n${JSON.stringify(echoOf(created), null, 2)}`)

    /** Re-read first: a stale `resourceVersion` is rejected (learned the hard way in the sizing probe). */
    const send = (label: string, payload: () => ReturnType<typeof NodeGroupSpec.fromPartial>) =>
      Effect.gen(function* () {
        const before = yield* mk8s.nodeGroup.get(ngId)
        const outcome = yield* mk8s.nodeGroup
          .update({
            metadata: { id: ngId, resourceVersion: before.metadata!.resourceVersion.toString() },
            spec: payload(),
          })
          .pipe(
            Effect.map(() => 'ACCEPTED'),
            Effect.catch((error) => Effect.succeed(`REJECTED — ${String(error)}`)),
          )
        const after = yield* mk8s.nodeGroup.get(ngId)
        console.log(`\n== ${label} ==\n  outcome: ${outcome}\n  echo: ${JSON.stringify(echoOf(after))}`)
        return outcome
      })

    // ── ARM A: is `template.nvlink` mutable at all? ──────────────────────────
    // A **well-formed but non-existent** id on purpose. (The first run of this probe used
    // `nvlinstancegroup-…`, and the API answered `3 INVALID_ARGUMENT: NVLInstanceGroupID is invalid …
    // expected id types: computenvlinstancegroup, got "nvlinstancegroup"` — a *prefix* check that
    // happens before the field is judged, which is why the id format matters here. Note the brand in
    // `compute/v1/ids.ts` carries no such refinement, deliberately: the service is the authority on
    // shape, so a typo like this surfaces at apply time rather than at plan time.)
    //
    // The question is which failure comes back now: "…not found" means the API accepted the field and
    // went looking for the group (**mutable**, so the CLI's omission from `update` is create-oriented);
    // "cannot be changed"/"immutable" means it refused the field itself, which is the CLI's story.
    yield* send('ARM A (add template.nvlink with a well-formed, non-existent id)', () =>
      NodeGroupSpec.fromPartial({
        fixedNodeCount: Long.fromNumber(1),
        template: {
          ...baseTemplate,
          taints: [{ key: 'alchemy-probe', value: 'yes', effect: 1 }],
          nvlink: { nvlInstanceGroupId: 'computenvlinstancegroup-e00alchemyprobe' },
        },
      }),
    )

    // ── ARM B: does an omitted field inside the `template` message survive? ──
    // Sends the same template *without* `taints` (pinned at create) and without `nvlink`. If the taint
    // survives, the template merges like `strategy` did and "omit ⇒ leave unchanged" holds a level
    // deeper; if it disappears, then any update resets every unpinned template field — which the
    // `news.<field> !== undefined` guards would have to carry instead.
    yield* send('ARM B (template without taints or nvlink)', () =>
      NodeGroupSpec.fromPartial({ fixedNodeCount: Long.fromNumber(1), template: baseTemplate }),
    )

    const final = yield* mk8s.nodeGroup.get(ngId)
    console.log(
      `\nSUMMARY` +
        `\n  create: ${JSON.stringify(echoOf(created))}` +
        `\n  final:  ${JSON.stringify(echoOf(final))}` +
        `\n  → ARM A tells you mutable vs refused; ARM B tells you whether a pinned taint survived the` +
        `\n    update that omitted it (merge) or vanished (replace-the-whole-message).`,
    )
  }).pipe(
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
