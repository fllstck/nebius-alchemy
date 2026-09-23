/**
 * mk8s **roll-out arms, re-measured with a witness** (2026-09-24).
 *
 * Why this probe exists: `spikes/mk8s-rollout-probe.ts` read `status.outdatedNodeCount` and found `0`
 * in every arm, and concluded that `taints` / `metadata.labels` / `cloudInitUserData` changes are
 * *sticky* (accepted into `spec`, no roll-out). `spikes/mk8s-rollout-control-probe.ts` then produced a
 * **positive control** that breaks that reading:
 *
 *   * a `template.resources.preset` change **is** a roll-out —
 *     the node's compute instance went from `computeinstance-e00pzxz2wbe0ezfyde` to
 *     `computeinstance-e00c9g585aes307th2` (new id, new name suffix), and
 *   * `status.outdatedNodeCount` read **`0` both before and after** that replacement, and the update
 *     call itself stayed open for ~9 minutes (the operation covers the roll-out).
 *
 * So the counter is not a witness at all: a roll-out that completes inside the update call leaves it at
 * `0`, exactly like a sticky field. Probe 1's arms each had several minutes of update latency, which is
 * the same order as the control's — so "counters unchanged" proved nothing there.
 *
 * This probe re-measures the same arms with the witness that cannot be fooled — the project's compute
 * instance set — and samples it **while the update is still in flight** (the previous runs only looked
 * after the call returned, which is precisely the window that hides the replacement). Every line is
 * timestamped, and the update call's duration is reported, because latency turned out to be the other
 * usable signal.
 *
 * Arms, in this order (the candidate fields before the control, so nothing is measured on a node a
 * previous arm replaced):
 *
 *   1. `template.taints` value change — the proto says taints are *not* propagated to existing nodes.
 *   2. `cloudInitUserData` change — the headline question (TASKS §N5 probe 2).
 *   3. `template.metadata.labels` change — the same claim as taints, for the other map.
 *   4. **control**: `template.resources.preset` change — must replace the node (measured above), so it
 *      calibrates the witness and the latency for this very run.
 *
 *   bun spikes/mk8s-rollout-arms-probe.ts 2>&1 | tee /tmp/mk8s-rollout-arms-probe.log
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import Long from 'long'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as ComputeGrpcModule from '../modules/api-client/compute.ts'
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
const { ComputeGrpcService, ComputeGrpcServiceLive } = ComputeGrpcModule
const { IamGrpcService, IamGrpcServiceLive } = IamGrpcModule
const { VpcGrpcService, VpcGrpcServiceLive } = VpcGrpcModule
const { NodeGroupSpec } = NodeGroupSchema

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const SERVICE_ACCOUNT_ID = process.env.NEBIUS_SA_ID ?? 'serviceaccount-e00r4d1ae86rb4n03a'
const SUBNET_ID = process.env.NEBIUS_SUBNET_ID ?? 'vpcsubnet-e00rf5t1vkbq0ew96x'
const PLATFORM = 'cpu-d3'
const PRESET = '2vcpu-8gb'
/** A different, real preset of the same platform — the control that MUST replace the node. */
const CONTROL_PRESET = '4vcpu-16gb'
const CLUSTER_NAME = 'alchemy-mk8s-arms-probe'
const NODE_GROUP_NAME = 'alchemy-mk8s-arms-probe-ng'

/** How often to read the witness while an update is in flight. */
const POLL_SECONDS = 15

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
const stamp = () => new Date().toISOString().slice(11, 19)
const log = (label: string, value: unknown) =>
  console.log(`\n[${stamp()}] == ${label} ==\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

const specJson = (spec: NodeGroupSchema.NodeGroupSpec | undefined): unknown =>
  spec === undefined ? null : NodeGroupSchema.NodeGroupSpec.toJSON(spec)
const templateJson = (template: NodeGroupSchema.NodeTemplate | undefined): unknown =>
  template === undefined ? null : NodeGroupSchema.NodeTemplate.toJSON(template)

const counts = (ng: NodeGroupSchema.NodeGroup) => ({
  state: ng.status?.state === undefined ? null : NodeGroupSchema.nodeGroupStatus_StateToJSON(ng.status.state),
  reconciling: ng.status?.reconciling ?? false,
  target: ng.status?.targetNodeCount?.toString() ?? null,
  node: ng.status?.nodeCount?.toString() ?? null,
  ready: ng.status?.readyNodeCount?.toString() ?? null,
  outdated: ng.status?.outdatedNodeCount?.toString() ?? null,
  rv: ng.metadata?.resourceVersion?.toString() ?? null,
})

/** The witness: a roll-out replaces the VM, so its compute instance id changes. A sticky field does not. */
const instanceIds = (compute: ComputeGrpcModule.ComputeGrpcServiceShape) =>
  Effect.gen(function* () {
    const rows = yield* compute.instance.list(PROJECT_ID)
    return rows.map((instance) => instance.metadata?.id ?? '?')
  })

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService
  const compute = yield* ComputeGrpcService
  const iam = yield* IamGrpcService
  const vpc = yield* VpcGrpcService

  const clusters = yield* mk8s.cluster.list(PROJECT_ID)
  const instances = yield* instanceIds(compute)
  log('PREFLIGHT', { clusters: clusters.length, instances })
  if (clusters.length > 0 || instances.length > 0) {
    console.error('ABORT — the environment is not empty.')
    return
  }
  const subnet = yield* vpc.subnet.get(SUBNET_ID).pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  const sa = yield* iam.serviceAccount
    .get(SERVICE_ACCOUNT_ID)
    .pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  if (typeof subnet === 'string' || typeof sa === 'string') {
    console.error(`ABORT — need the pre-existing subnet and service account: ${String(subnet)} / ${String(sa)}`)
    return
  }

  const cpVersions = (yield* mk8s.cluster.listControlPlaneVersions).map((version) => version.version)
  const clusterVersion = cpVersions.includes('1.35') ? '1.35' : cpVersions[0]
  if (clusterVersion === undefined) {
    console.error('ABORT — no control-plane version offered.')
    return
  }
  const matrix = yield* mk8s.nodeGroup.getCompatibilityMatrix({
    clusterKubernetesVersion: clusterVersion,
    platform: PLATFORM,
  })
  const nodeVersion = matrix.versions[0]?.kubernetesVersion
  if (nodeVersion === undefined) {
    console.error('ABORT — no node version for this cluster version + platform.')
    return
  }

  const cluster = yield* mk8s.cluster.create({
    metadata: { parentId: PROJECT_ID, name: CLUSTER_NAME },
    spec: { controlPlane: { version: clusterVersion, subnetId: SUBNET_ID, etcdClusterSize: Long.fromNumber(1) } },
  })
  const clusterId = cluster.metadata!.id
  console.log(`[${stamp()}] cluster created: ${clusterId} (control plane ${clusterVersion}, node version ${nodeVersion})`)

  yield* Effect.gen(function* () {
    const template = (over: Record<string, unknown> = {}) => ({
      os: 'ubuntu24.04',
      resources: { platform: PLATFORM, preset: PRESET },
      bootDisk: { type: 'NETWORK_SSD', sizeGibibytes: 64 },
      networkInterfaces: [{ subnetId: SUBNET_ID }],
      serviceAccountId: SERVICE_ACCOUNT_ID,
      cloudInitUserData: '#cloud-config\n# arms probe baseline\n',
      metadata: { labels: { 'probe-node': 'a' } },
      taints: [{ key: 'probe.dev/dedicated', value: 'a', effect: 'NO_SCHEDULE' }],
      ...over,
    })

    const ng = yield* mk8s.nodeGroup.create({
      metadata: { parentId: clusterId, name: NODE_GROUP_NAME },
      spec: NodeGroupSpec.fromJSON({ version: nodeVersion, fixedNodeCount: 1, template: template() }),
    })
    const ngId = ng.metadata!.id
    console.log(`[${stamp()}] node group created: ${ngId}`)

    let live = ng
    const deadline = Date.now() + 20 * 60 * 1000
    let last = ''
    while (Date.now() < deadline) {
      live = yield* mk8s.nodeGroup.get(ngId)
      const now = JSON.stringify(counts(live))
      if (now !== last) {
        console.log(`[${stamp()}] provisioning: ${now}`)
        last = now
      }
      if (
        live.status?.state === NodeGroupSchema.NodeGroupStatus_State.RUNNING &&
        (live.status.readyNodeCount?.toNumber() ?? 0) >= 1
      ) {
        break
      }
      yield* sleep(20)
    }
    const baseline = yield* instanceIds(compute)
    log('BASELINE', { status: counts(live), instances: baseline })

    /**
     * Send an update and **watch while it is in flight**: the operation covers the roll-out, so every
     * earlier probe only saw the world after the replacement had already happened. A sibling fiber reads
     * the witness every 15 s until the call returns, and the call's duration is reported — the other
     * usable signal, since it is what separates a sticky field from a roll-out that finishes inside the
     * call.
     */
    const arm = (label: string, payload: (fresh: NodeGroupSchema.NodeGroup) => Record<string, unknown>) =>
      Effect.gen(function* () {
        console.log(`\n${'─'.repeat(78)}\n[${stamp()}] ARM: ${label}\n${'─'.repeat(78)}`)
        const before = yield* mk8s.nodeGroup.get(ngId)
        const beforeInstances = yield* instanceIds(compute)
        console.log(`  before: ${JSON.stringify(counts(before))} instances=${JSON.stringify(beforeInstances)}`)

        const startedAt = Date.now()
        const finished = yield* Ref.make(false)
        const timeline: Array<{ t: number; counts: unknown; instances: string[] }> = []
        let sawOutdated = false
        const sampler = Effect.gen(function* () {
          while (!(yield* Ref.get(finished))) {
            const current = yield* mk8s.nodeGroup.get(ngId)
            const currentInstances = yield* instanceIds(compute)
            const row = {
              t: Math.round((Date.now() - startedAt) / 1000),
              counts: counts(current),
              instances: currentInstances,
            }
            timeline.push(row)
            console.log(`  during ${JSON.stringify(row)}`)
            if (current.status?.outdatedNodeCount?.toNumber() !== 0) sawOutdated = true
            yield* sleep(POLL_SECONDS)
          }
        })

        const samplerFiber = yield* Effect.forkChild(sampler)
        const accepted = yield* push(payload(before))
        yield* Ref.set(finished, true)
        yield* Fiber.interrupt(samplerFiber)

        const seconds = Math.round((Date.now() - startedAt) / 1000)
        const after = yield* mk8s.nodeGroup.get(ngId)
        const afterInstances = yield* instanceIds(compute)
        const replaced = JSON.stringify(afterInstances) !== JSON.stringify(beforeInstances)
        log(`ARM RESULT — ${label}`, {
          accepted: accepted !== undefined,
          updateCallSeconds: seconds,
          replacedTheNode: replaced,
          beforeInstances,
          afterInstances,
          outdatedEverNonZero: sawOutdated,
          samplesTakenDuringCall: timeline.length,
          distinctStatesDuringCall: [...new Set(timeline.map((row) => JSON.stringify(row.counts)))].length,
          spec: templateJson(after.spec?.template),
        })
        return { label, replaced, seconds, beforeInstances, afterInstances }
      })

    const push = (payload: Record<string, unknown>) =>
      Effect.gen(function* () {
        const fresh = yield* mk8s.nodeGroup.get(ngId)
        return yield* mk8s.nodeGroup
          .update({
            metadata: { id: ngId, resourceVersion: fresh.metadata!.resourceVersion.toString() },
            spec: NodeGroupSpec.fromJSON(payload),
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => console.log(`  [${stamp()}] update operation completed`))),
            Effect.catch((error) =>
              Effect.sync(() => {
                console.log(`  [${stamp()}] update REJECTED: ${String(error)}`)
                return undefined
              }),
            ),
          )
      })

    const withTemplate = (fresh: NodeGroupSchema.NodeGroup, over: Record<string, unknown>) => ({
      version: fresh.spec?.version === undefined || fresh.spec.version === '' ? nodeVersion : fresh.spec.version,
      fixedNodeCount: 1,
      template: { ...(templateJson(fresh.spec?.template) as Record<string, unknown>), ...over },
    })

    // ── 1. taints: the proto claims these are NOT propagated to existing nodes ──
    const taints = yield* arm('template.taints value a → b', (fresh) =>
      withTemplate(fresh, { taints: [{ key: 'probe.dev/dedicated', value: 'b', effect: 'NO_SCHEDULE' }] }),
    )

    // ── 2. cloudInitUserData: the headline question ──
    const userData = yield* arm('cloudInitUserData + PROBE-MARKER', (fresh) =>
      withTemplate(fresh, { cloudInitUserData: '#cloud-config\n# arms probe baseline\n# PROBE-MARKER\n' }),
    )

    // ── 3. node labels: same claim as taints, other map ──
    const labels = yield* arm('template.metadata.labels probe-node a → b', (fresh) => {
      const current = templateJson(fresh.spec?.template) as Record<string, unknown>
      const metadata = current.metadata as Record<string, unknown> | undefined
      return withTemplate(fresh, { metadata: { ...metadata, labels: { 'probe-node': 'b' } } })
    })

    // ── 4. CONTROL: a preset change, which must replace the node ──
    const control = yield* arm(`template.resources.preset ${PRESET} → ${CONTROL_PRESET} (CONTROL)`, (fresh) =>
      withTemplate(fresh, { resources: { platform: PLATFORM, preset: CONTROL_PRESET } }),
    )

    log('SUMMARY — all four arms, one run', {
      baselineInstances: baseline,
      arms: [taints, userData, labels, control].map((result) => ({
        arm: result.label,
        replacedTheNode: result.replaced,
        updateCallSeconds: result.seconds,
      })),
      reading:
        'The control must read replacedTheNode=true: it is the calibration for the witness. ' +
        'Any candidate arm that also reads true rolled the node out; one that reads false is sticky.',
    })

    const final = yield* mk8s.nodeGroup.get(ngId)
    log('FINAL spec echo', specJson(final.spec))
  }).pipe(
    Effect.ensuring(
      mk8s.cluster
        .delete(clusterId)
        .pipe(
          Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] cleanup — cluster deleted (cascade): ${clusterId}`))),
          Effect.catch((error) =>
            Effect.sync(() => console.error(`cleanup FAILED — delete the cluster by hand: ${clusterId}: ${String(error)}`)),
          ),
        ),
    ),
  )

  yield* sleep(10)
  const [clustersAfter, instancesAfter] = yield* Effect.all([mk8s.cluster.list(PROJECT_ID), instanceIds(compute)])
  log('POSTFLIGHT', { clusters: clustersAfter.length, instances: instancesAfter })
  if (clustersAfter.length > 0 || instancesAfter.length > 0) console.error('LEAK — clean up by hand.')
})

const transportLayer = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)
const servicesLayer = Layer.mergeAll(
  Mk8sGrpcServiceLive,
  ComputeGrpcServiceLive,
  IamGrpcServiceLive,
  VpcGrpcServiceLive,
).pipe(Layer.provide(transportLayer))

try {
  await Effect.runPromise(program.pipe(Effect.provide(servicesLayer), Effect.scoped))
  console.log(`\n[${stamp()}] PROBE DONE`)
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
