/**
 * mk8s **roll-out / stickiness / absent-scalar** probe (2026-09-24).
 *
 * The last two open questions in TASKS.md §N5, answered by one run on one node group (the VM is the
 * expensive part, so the arms share it):
 *
 *   1. **Which template changes roll the nodes out?** `taints` and `metadata.labels` are documented
 *      by the proto as *sticky* — "will not be propagated to existing nodes, so will be applied only
 *      to Kubernetes Nodes created after the field change" — and TASKS.md records the same claim for
 *      `cloudInitUserData` (from soperator's README, i.e. a *library* claim, never measured).
 *      "Sticky" and "rolls out" are opposite outcomes and the difference is observable: a roll-out
 *      moves `status.outdatedNodeCount` (nodes whose configuration is outdated and which a roll-out
 *      will replace); a sticky field leaves it at 0 forever.
 *   2. **Does an ordinary absent scalar clear?** The sizing probe settled this for the exclusive
 *      sizing pair (`fixedNodeCount` ⇄ `autoscaling` — the omitted side IS cleared) and for a message
 *      (`strategy` — an omitted *field inside* it merges, the message itself was preserved). A plain
 *      scalar (`template.maxPods`, `spec.version`) was never measured either way. The provider's
 *      behaviour does not depend on the answer (omitted fields are never compared, and every request
 *      carries the full pinned set) — a *doc claim* does, and the proto documents `maxPods`
 *      defaulting to 110, which a "clears" answer would turn into a real trap.
 *
 * Arm order is deliberate: the fields that need a *stable* group go first (a roll-out in flight could
 * make a later `outdatedNodeCount` reading ambiguous), and the one arm that is expected to roll out —
 * `cloudInitUserData` — goes last, with the longest sampling window.
 *
 * Every step prints **values, not keys** (the lesson from the first NodeGroup live run), redacts the
 * user-data, and re-reads the resource before each update for a fresh `resourceVersion` (a stale token
 * is rejected with `9 FAILED_PRECONDITION: resource_version mismatch` — the sizing probe lost an arm
 * that way). Teardown is `Effect.ensuring`: deleting the cluster cascades the node group, its
 * instances and their boot disks, and the script re-lists clusters afterwards to prove it.
 *
 *   bun spikes/mk8s-rollout-probe.ts 2>&1 | tee /tmp/mk8s-rollout-probe.log
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import Long from 'long'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as IamGrpcModule from '../modules/api-client/iam.ts'
import * as Mk8sGrpcModule from '../modules/api-client/mk8s.ts'
import * as VpcGrpcModule from '../modules/api-client/vpc.ts'
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
const { IamGrpcService, IamGrpcServiceLive } = IamGrpcModule
const { VpcGrpcService, VpcGrpcServiceLive } = VpcGrpcModule
const { NodeGroupSpec } = NodeGroupSchema

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const SERVICE_ACCOUNT_ID = process.env.NEBIUS_SA_ID ?? 'serviceaccount-e00r4d1ae86rb4n03a'
/** The pre-existing default subnet (the probe-only second subnet was deleted after the 2026-09-23 run). */
const SUBNET_ID = process.env.NEBIUS_SUBNET_ID ?? 'vpcsubnet-e00rf5t1vkbq0ew96x'
const PLATFORM = 'cpu-d3'
const PRESET = '2vcpu-8gb'
const CLUSTER_NAME = 'alchemy-mk8s-rollout-probe'
const NODE_GROUP_NAME = 'alchemy-mk8s-rollout-probe-ng'

/** How long one arm samples its status counters — long enough for the operator to mark the roll-out. */
const ARM_SAMPLE_SECONDS = [0, 30, 90]
/** The `cloudInitUserData` arm gets a longer window: a roll-out may take a while to register. */
const ROLLOUT_SAMPLE_SECONDS = [0, 30, 90, 180]

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

const sleep = (seconds: number) => Effect.sleep(`${seconds} seconds`)
const log = (label: string, value: unknown) =>
  console.log(`\n== ${label} ==\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

// ts-proto renders a message through its **companion** (`NodeGroupSpec.toJSON(spec)`), not as an
// instance method — the decoded instances are plain objects. The companion is also what turns Longs
// into decimal strings and enums into names, which is the rendering every printed value here uses.
const specJson = (spec: NodeGroupSchema.NodeGroupSpec | undefined): unknown =>
  spec === undefined ? null : NodeGroupSchema.NodeGroupSpec.toJSON(spec)
const templateJson = (template: NodeGroupSchema.NodeTemplate | undefined): unknown =>
  template === undefined ? null : NodeGroupSchema.NodeTemplate.toJSON(template)
const autoscalingJson = (value: NodeGroupSchema.NodeGroupAutoscalingSpec | undefined): unknown =>
  value === undefined ? null : NodeGroupSchema.NodeGroupAutoscalingSpec.toJSON(value)
const taintsJson = (value: ReadonlyArray<NodeGroupSchema.NodeTaint> | undefined): unknown =>
  value === undefined ? null : value.map((taint) => NodeGroupSchema.NodeTaint.toJSON(taint))
const counts = (ng: NodeGroupSchema.NodeGroup) => ({
  state: ng.status?.state === undefined ? null : NodeGroupSchema.nodeGroupStatus_StateToJSON(ng.status.state),
  reconciling: ng.status?.reconciling ?? false,
  target: ng.status?.targetNodeCount?.toString() ?? null,
  node: ng.status?.nodeCount?.toString() ?? null,
  ready: ng.status?.readyNodeCount?.toString() ?? null,
  outdated: ng.status?.outdatedNodeCount?.toString() ?? null,
  nodeImageVersion: ng.status?.version ?? null,
  resourceVersion: ng.metadata?.resourceVersion?.toString() ?? null,
})

/** The spec facts each arm is about — printed as values, with the user-data reduced to a fingerprint. */
const specFacts = (spec: NodeGroupSchema.NodeGroupSpec | undefined) => ({
  version: spec?.version === undefined || spec.version === '' ? '(empty/absent)' : spec.version,
  fixedNodeCount: spec?.fixedNodeCount?.toString() ?? '(absent)',
  autoscaling: autoscalingJson(spec?.autoscaling) ?? '(absent)',
  templateMaxPods: spec?.template?.maxPods === undefined ? '(absent)' : spec.template.maxPods.toString(),
  templateNodeLabels: spec?.template?.metadata?.labels ?? null,
  templateInstanceLabels: spec?.template?.instanceMetadata?.labels ?? null,
  templateTaints: taintsJson(spec?.template?.taints),
  cloudInit: (() => {
    const data = spec?.template?.cloudInitUserData ?? ''
    // The *fingerprint* is the measurement: does the API keep the old string, and does it echo the new one?
    return `len=${data.length} first=${JSON.stringify(data.split('\n')[0])} marker=${data.includes('PROBE-MARKER') ? 'yes' : 'no'}`
  })(),
})

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService
  const iam = yield* IamGrpcService
  const vpc = yield* VpcGrpcService

  // ── Preflight: the environment must be empty, and the subnet + SA must still exist ──
  const preflight = yield* mk8s.cluster.list(PROJECT_ID)
  log('PREFLIGHT cluster.list(project)', { count: preflight.length })
  if (preflight.length > 0) {
    console.error('ABORT — clusters exist; the environment is not empty:', preflight.map((c) => c.metadata?.name))
    return
  }
  const subnet = yield* vpc.subnet
    .get(SUBNET_ID)
    .pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  console.log(`PREFLIGHT subnet ${SUBNET_ID}:`, typeof subnet === 'string' ? `MISSING/ERROR — ${subnet}` : (subnet.metadata?.name ?? '(no name)'))
  const sa = yield* iam.serviceAccount
    .get(SERVICE_ACCOUNT_ID)
    .pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  console.log(`PREFLIGHT service account ${SERVICE_ACCOUNT_ID}:`, typeof sa === 'string' ? `MISSING/ERROR — ${sa}` : (sa.metadata?.name ?? '(no name)'))
  if (typeof subnet === 'string' || typeof sa === 'string') {
    console.error('ABORT — the probe needs the pre-existing subnet and service account (or set NEBIUS_SUBNET_ID / NEBIUS_SA_ID).')
    return
  }

  // ── Which control-plane version, and which node version does the matrix offer for it? ──
  const controlPlaneVersions = yield* mk8s.cluster.listControlPlaneVersions
  const cpVersions = controlPlaneVersions.map((version) => version.version)
  log('PREFLIGHT control-plane versions', cpVersions)
  const clusterVersion = cpVersions.includes('1.35') ? '1.35' : cpVersions[0]
  if (clusterVersion === undefined) {
    console.error('ABORT — the tenant offers no control-plane version.')
    return
  }

  // The node version to pin: the matrix is the live authority (a version the images do not carry is
  // rejected), and pinning one is what makes the "omit `version` ⇒ does it clear?" arm meaningful.
  // Queried **before** the cluster exists — this whole preflight is read-only, so a bad request shape
  // cannot cost a VM.
  const matrix = yield* mk8s.nodeGroup.getCompatibilityMatrix({
    clusterKubernetesVersion: clusterVersion,
    platform: PLATFORM,
  })
  log(
    `compatibility matrix (cluster ${clusterVersion} · ${PLATFORM})`,
    matrix.versions.map((version) => ({
      kubernetesVersion: version.kubernetesVersion,
      images: version.items.map((item) => `${item.os}${item.driversPreset === '' ? '' : `/${item.driversPreset}`}`),
    })),
  )
  const nodeVersion = matrix.versions[0]?.kubernetesVersion
  if (nodeVersion === undefined) {
    console.error('ABORT — no node version for this cluster version + platform.')
    return
  }
  console.log(`pinning the node group's spec.version to: ${nodeVersion}`)

  // ── Create the cluster (etcdClusterSize 1 keeps the control plane non-HA and cheap) ──
  const cluster = yield* mk8s.cluster.create({
    metadata: { parentId: PROJECT_ID, name: CLUSTER_NAME },
    spec: { controlPlane: { version: clusterVersion, subnetId: SUBNET_ID, etcdClusterSize: Long.fromNumber(1) } },
  })
  const clusterId = cluster.metadata!.id
  console.log(`\ncluster created: ${clusterId} (control plane ${clusterVersion})`)

  yield* Effect.gen(function* () {
    // ── The template every arm sends (in full, except where an arm omits one field on purpose) ──
    // `fromJSON` (not `fromPartial`) because `bootDisk.type` and `taints[].effect` are **enums**: the
    // props spell them as names, and `fromPartial` would pass the string through to the int32 field.
    const template = (over: Record<string, unknown> = {}) => ({
      os: 'ubuntu24.04',
      resources: { platform: PLATFORM, preset: PRESET },
      bootDisk: { type: 'NETWORK_SSD', sizeGibibytes: 64 },
      networkInterfaces: [{ subnetId: SUBNET_ID }],
      serviceAccountId: SERVICE_ACCOUNT_ID,
      cloudInitUserData: '#cloud-config\n# probe baseline\n',
      // Both label maps are pinned to a known value so the arms can change exactly one of them.
      metadata: { labels: { 'probe-node': 'a' } },
      instanceMetadata: { labels: { 'probe-instance': 'a' } },
      taints: [{ key: 'probe.dev/dedicated', value: 'a', effect: 'NO_SCHEDULE' }],
      // A value that is *not* the documented default (110), so "cleared" and "kept" are distinguishable.
      maxPods: 96,
      ...over,
    })

    const createPayload = NodeGroupSpec.fromJSON({
      version: nodeVersion,
      fixedNodeCount: 1,
      template: template(),
    })

    let ng = yield* mk8s.nodeGroup.create({
      metadata: { parentId: clusterId, name: NODE_GROUP_NAME },
      spec: createPayload,
    })
    const ngId = ng.metadata!.id
    console.log(`\nnode group created: ${ngId}`)

    // ── Wait for a real, joined node: the counters only mean something once one exists ──
    const deadline = Date.now() + 20 * 60 * 1000
    let last = ''
    while (Date.now() < deadline) {
      ng = yield* mk8s.nodeGroup.get(ngId)
      const now = JSON.stringify(counts(ng))
      if (now !== last) {
        console.log(`  provisioning: ${now}`)
        last = now
      }
      if (ng.status?.state === NodeGroupSchema.NodeGroupStatus_State.RUNNING && (ng.status.readyNodeCount?.toNumber() ?? 0) >= 1) {
        break
      }
      yield* sleep(20)
    }
    log('BASELINE (after create, node joined)', { status: counts(ng), spec: specFacts(ng.spec) })
    const baseline = counts(ng)
    if (baseline.ready !== '1') {
      console.error('WARNING — no ready node within the deadline; the counters below may be uninformative.')
    }
    console.log(
      `\nNOTE for reading the arms: a template change that the platform will roll out should move` +
        `\n  status.outdatedNodeCount above ${baseline.outdated}, or move target/node counts as nodes are replaced.`,
    )

    /**
     * One arm: re-read for a fresh `resourceVersion`, send the payload, then sample the counters for
     * a fixed window. Returns the samples so the caller can print a summary.
     */
    const arm = (label: string, sampleSeconds: ReadonlyArray<number>, payload: (fresh: NodeGroupSchema.NodeGroup) => unknown) =>
      Effect.gen(function* () {
        console.log(`\n${'─'.repeat(78)}\nARM: ${label}\n${'─'.repeat(78)}`)
        const before = yield* mk8s.nodeGroup.get(ngId)
        console.log(`  before: ${JSON.stringify(counts(before))}`)
        const accepted = yield* mk8s.nodeGroup
          .update({
            metadata: { id: ngId, resourceVersion: before.metadata!.resourceVersion.toString() },
            spec: NodeGroupSpec.fromJSON(payload(before)),
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => console.log('  update ACCEPTED'))),
            Effect.catch((error) =>
              Effect.sync(() => {
                console.log(`  update REJECTED: ${String(error)}`)
                return undefined
              }),
            ),
          )
        if (accepted === undefined) return { label, samples: [], spec: null }
        const samples: unknown[] = []
        for (const [index, seconds] of sampleSeconds.entries()) {
          if (index > 0) yield* sleep(seconds - (sampleSeconds[index - 1] ?? 0))
          const fresh = yield* mk8s.nodeGroup.get(ngId)
          const sample = { t: `+${seconds}s`, ...counts(fresh) }
          samples.push(sample)
          console.log(`  ${JSON.stringify(sample)}`)
        }
        const final = yield* mk8s.nodeGroup.get(ngId)
        const facts = specFacts(final.spec)
        log(`  spec after ${label}`, facts)
        return { label, samples, spec: facts }
      })

    const results: Array<{ label: string; samples: unknown[]; spec: unknown }> = []

    // ── Arm 1: a TAINT change (the proto says: applied only to Nodes created after the change) ──
    results.push(
      yield* arm('taint value a → b (proto: NOT rolled out to existing nodes)', ARM_SAMPLE_SECONDS, () => ({
        version: nodeVersion,
        fixedNodeCount: 1,
        template: template({ taints: [{ key: 'probe.dev/dedicated', value: 'b', effect: 'NO_SCHEDULE' }] }),
      })),
    )

    // ── Arm 2: a k8s NODE-label change (same claim as taints) ──
    results.push(
      yield* arm('node label probe-node a → b (proto: NOT rolled out)', ARM_SAMPLE_SECONDS, () => ({
        version: nodeVersion,
        fixedNodeCount: 1,
        template: template({ metadata: { labels: { 'probe-node': 'b' } } }),
      })),
    )

    // ── Arm 3: an instance-METADATA label change (the second, distinct map) ──
    results.push(
      yield* arm('instance-metadata label probe-instance a → b', ARM_SAMPLE_SECONDS, () => ({
        version: nodeVersion,
        fixedNodeCount: 1,
        template: template({ instanceMetadata: { labels: { 'probe-instance': 'b' } } }),
      })),
    )

    // ── Arm 4: OMIT a plain scalar that the create pinned (maxPods 96) — does it clear? ──
    // The template object is rebuilt without the key, i.e. exactly what `desiredSpec` sends when the
    // user removes the prop. `spec.template.maxPods` is what the drift check would compare.
    const withoutMaxPods = template()
    delete (withoutMaxPods as Record<string, unknown>).maxPods
    results.push(
      yield* arm('omit template.maxPods (pinned 96 at create) — does an absent scalar clear?', ARM_SAMPLE_SECONDS, () => ({
        version: nodeVersion,
        fixedNodeCount: 1,
        template: withoutMaxPods,
      })),
    )

    // ── Arm 5: OMIT `spec.version` (pinned at create) — the same question one level up ──
    results.push(
      yield* arm('omit spec.version (pinned at create) — does an absent scalar clear?', ARM_SAMPLE_SECONDS, (fresh) => ({
        // Keep whatever sizing + template the live resource carries; only `version` is dropped.
        fixedNodeCount: fresh.spec?.fixedNodeCount?.toNumber() ?? 1,
        ...(fresh.spec?.autoscaling !== undefined ? { autoscaling: autoscalingJson(fresh.spec.autoscaling) } : {}),
        template: templateJson(fresh.spec?.template) as Record<string, unknown>,
      })),
    )

    // ── Arm 6 (last, and the one expected to roll out): a cloudInitUserData change ──
    results.push(
      yield* arm(
        'cloudInitUserData change (marker added) — does it roll nodes out?',
        ROLLOUT_SAMPLE_SECONDS,
        () => ({
          version: nodeVersion,
          fixedNodeCount: 1,
          template: template({ cloudInitUserData: '#cloud-config\n# probe baseline\n# PROBE-MARKER\n' }),
        }),
      ),
    )

    // ── The reading ───────────────────────────────────────────────────────────
    log(
      'SUMMARY — one row per arm; `outdated` moving above 0 means the platform WILL roll the nodes out',
      results.map((result) => ({
        arm: result.label,
        outdated: result.samples.map((sample) => (sample as { outdated: string | null }).outdated),
        target: result.samples.map((sample) => (sample as { target: string | null }).target),
        node: result.samples.map((sample) => (sample as { node: string | null }).node),
        ready: result.samples.map((sample) => (sample as { ready: string | null }).ready),
        reconciling: result.samples.map((sample) => (sample as { reconciling: boolean }).reconciling),
        specAfter: result.spec,
      })),
    )

    const finalNg = yield* mk8s.nodeGroup.get(ngId)
    log('FINAL spec echo (full JSON)', specJson(finalNg.spec))
    log('FINAL status', counts(finalNg))
  }).pipe(
    // Guaranteed teardown: the cluster delete cascades node groups + instances + their disks.
    Effect.ensuring(
      mk8s.cluster
        .delete(clusterId)
        .pipe(
          Effect.map(() => console.log(`\ncleanup — cluster deleted (cascade): ${clusterId}`)),
          Effect.catch((error) =>
            Effect.sync(() =>
              console.error(`cleanup FAILED — delete the cluster by hand: ${clusterId}: ${String(error)}`),
            ),
          ),
        ),
    ),
  )

  // ── Prove the environment is empty again ──
  yield* Effect.sleep('10 seconds' as const)
  const after = yield* mk8s.cluster.list(PROJECT_ID).pipe(
    Effect.retry(Schedule.recurs(5)),
    Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)),
  )
  log('POSTFLIGHT cluster.list(project)', typeof after === 'string' ? `ERROR — ${after}` : { count: after.length })
  if (typeof after !== 'string' && after.length > 0) {
    console.error('LEAK — delete the remaining clusters by hand:', after.map((c) => `${c.metadata?.name} (${c.metadata?.id})`))
  }
})

const transportLayer = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)
const servicesLayer = Layer.mergeAll(
  Mk8sGrpcServiceLive,
  IamGrpcServiceLive,
  VpcGrpcServiceLive,
).pipe(Layer.provide(transportLayer))

try {
  await Effect.runPromise(program.pipe(Effect.provide(servicesLayer), Effect.scoped))
  console.log('\nPROBE DONE')
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
