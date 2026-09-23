/**
 * mk8s **roll-out control + filesystem-attach** probe (2026-09-24).
 *
 * `spikes/mk8s-rollout-probe.ts` measured that a `cloudInitUserData` / `taints` / label change is
 * accepted into `spec` and leaves `status.outdatedNodeCount` at `0` for its whole window — the reading
 * that "these fields are sticky". That reading has a hole this probe exists to fill: **every** arm in
 * that run read `0`, so a counter that simply never moves would have produced the same table. A claim
 * needs a positive control.
 *
 * So, in one node group:
 *
 *   1. **Positive control**: change a template field the service is documented to roll the nodes out
 *      for (the `PreflightCheck` probe measured `requiresUserApproval` + "will roll out the node
 *      group" for `template.resources.platform`), and watch **two** witnesses:
 *        * `status.outdatedNodeCount` / `targetNodeCount` / `nodeCount` (the counter), and
 *        * the **compute instance set** of the project (`compute.instance.list`) — a roll-out replaces
 *          the VM, so its instance id must change. This one cannot be fooled by a counter that is
 *          never populated, which is exactly why it is here.
 *      Candidate template changes are tried in order (a second CPU platform from the compatibility
 *      matrix's `compatiblePlatforms`, then a bigger preset on the same platform), because whether a
 *      given platform+preset pair is accepted is itself unmeasured.
 *   2. **`template.filesystems`** — the last arm-4 sub-surface this tenant can reach: create a real
 *      compute `Filesystem` and attach it by **update**, then read the echo back (the enum must arrive
 *      as `READ_WRITE` = 2, not as the string and not as `0`). The guest *mount* cannot be verified
 *      this way and is not claimed; what is verified is the wire shape and that the API accepts it.
 *
 * Teardown is `Effect.ensuring`: the cluster delete cascades the node group, its instances and their
 * boot disks, *then* the filesystem is deleted (it cannot go while a node has it attached), and the
 * postflight re-lists clusters, instances and filesystems to prove nothing leaked.
 *
 *   bun spikes/mk8s-rollout-control-probe.ts 2>&1 | tee /tmp/mk8s-rollout-control-probe.log
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
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
import * as FilesystemSchema from '../schemas/nebius/compute/v1/filesystem.ts'
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
const { FilesystemSpec } = FilesystemSchema

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const SERVICE_ACCOUNT_ID = process.env.NEBIUS_SA_ID ?? 'serviceaccount-e00r4d1ae86rb4n03a'
const SUBNET_ID = process.env.NEBIUS_SUBNET_ID ?? 'vpcsubnet-e00rf5t1vkbq0ew96x'
const PLATFORM = 'cpu-d3'
const PRESET = '2vcpu-8gb'
const CLUSTER_NAME = 'alchemy-mk8s-control-probe'
const NODE_GROUP_NAME = 'alchemy-mk8s-control-probe-ng'
const FILESYSTEM_NAME = 'alchemy-mk8s-control-probe-fs'

/** A real roll-out provisions a new VM, so the control arm needs minutes, not seconds. */
const CONTROL_SAMPLE_SECONDS = [0, 60, 180, 300]
const FS_SAMPLE_SECONDS = [0, 60, 150]

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

const specJson = (spec: NodeGroupSchema.NodeGroupSpec | undefined): unknown =>
  spec === undefined ? null : NodeGroupSchema.NodeGroupSpec.toJSON(spec)
const templateJson = (template: NodeGroupSchema.NodeTemplate | undefined): unknown =>
  template === undefined ? null : NodeGroupSchema.NodeTemplate.toJSON(template)
const autoscalingJson = (value: NodeGroupSchema.NodeGroupAutoscalingSpec | undefined): unknown =>
  value === undefined ? null : NodeGroupSchema.NodeGroupAutoscalingSpec.toJSON(value)

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

/**
 * The witness that cannot be fooled by an unpopulated counter: the project's compute instances. A
 * roll-out replaces the VM, so the id changes; a sticky field leaves the set untouched.
 */
const instanceWitness = (compute: ComputeGrpcModule.ComputeGrpcServiceShape) =>
  Effect.gen(function* () {
    const rows = yield* compute.instance.list(PROJECT_ID)
    return rows.map((instance) => `${instance.metadata?.name ?? '?'}(${instance.metadata?.id ?? '?'})`)
  })

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService
  const compute = yield* ComputeGrpcService
  const iam = yield* IamGrpcService
  const vpc = yield* VpcGrpcService

  // ── Preflight (read-only, before any spend) ──────────────────────────────
  const clusters = yield* mk8s.cluster.list(PROJECT_ID)
  const existingInstances = yield* instanceWitness(compute)
  const existingFilesystems = yield* compute.filesystem.list(PROJECT_ID)
  log('PREFLIGHT', {
    clusters: clusters.length,
    instances: existingInstances,
    filesystems: existingFilesystems.map((fs) => fs.metadata?.name),
  })
  if (clusters.length > 0 || existingInstances.length > 0) {
    console.error('ABORT — clusters or instances already exist; the environment is not empty.')
    return
  }
  const subnet = yield* vpc.subnet
    .get(SUBNET_ID)
    .pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  const sa = yield* iam.serviceAccount
    .get(SERVICE_ACCOUNT_ID)
    .pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  console.log(
    `PREFLIGHT subnet: ${typeof subnet === 'string' ? subnet : (subnet.metadata?.name ?? '?')} · ` +
      `service account: ${typeof sa === 'string' ? sa : (sa.metadata?.name ?? '?')}`,
  )
  if (typeof subnet === 'string' || typeof sa === 'string') {
    console.error('ABORT — need the pre-existing subnet and service account (NEBIUS_SUBNET_ID / NEBIUS_SA_ID).')
    return
  }

  const controlPlaneVersions = yield* mk8s.cluster.listControlPlaneVersions
  const cpVersions = controlPlaneVersions.map((version) => version.version)
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
  // The control candidates come from the matrix itself: `compatiblePlatforms` is the service's own
  // answer to "which platforms may run this image", so it cannot propose an impossible one.
  const platforms = [...new Set(matrix.versions[0]?.items.flatMap((item) => item.compatiblePlatforms) ?? [])]
  log(`PREFLIGHT matrix (cluster ${clusterVersion} · ${PLATFORM})`, {
    nodeVersion,
    items: matrix.versions[0]?.items.map((item) => ({ os: item.os, driversPreset: item.driversPreset })),
    compatiblePlatforms: platforms,
  })

  const cluster = yield* mk8s.cluster.create({
    metadata: { parentId: PROJECT_ID, name: CLUSTER_NAME },
    spec: { controlPlane: { version: clusterVersion, subnetId: SUBNET_ID, etcdClusterSize: Long.fromNumber(1) } },
  })
  const clusterId = cluster.metadata!.id
  console.log(`\ncluster created: ${clusterId} (control plane ${clusterVersion})`)

  let filesystemId: string | undefined

  yield* Effect.gen(function* () {
    const template = (over: Record<string, unknown> = {}) => ({
      os: 'ubuntu24.04',
      resources: { platform: PLATFORM, preset: PRESET },
      bootDisk: { type: 'NETWORK_SSD', sizeGibibytes: 64 },
      networkInterfaces: [{ subnetId: SUBNET_ID }],
      serviceAccountId: SERVICE_ACCOUNT_ID,
      cloudInitUserData: '#cloud-config\n# control probe baseline\n',
      ...over,
    })

    const ng = yield* mk8s.nodeGroup.create({
      metadata: { parentId: clusterId, name: NODE_GROUP_NAME },
      spec: NodeGroupSpec.fromJSON({ version: nodeVersion, fixedNodeCount: 1, template: template() }),
    })
    const ngId = ng.metadata!.id
    console.log(`\nnode group created: ${ngId}`)

    const deadline = Date.now() + 20 * 60 * 1000
    let live = ng
    let last = ''
    while (Date.now() < deadline) {
      live = yield* mk8s.nodeGroup.get(ngId)
      const now = JSON.stringify(counts(live))
      if (now !== last) {
        console.log(`  provisioning: ${now}`)
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

    const baselineInstances = yield* instanceWitness(compute)
    log('BASELINE', { status: counts(live), instances: baselineInstances, spec: specJson(live.spec) })

    /** Wait (bounded) until the service is not mid-reconciliation, so an update is not rejected. */
    const settle = (label: string) =>
      Effect.gen(function* () {
        const until = Date.now() + 6 * 60 * 1000
        while (Date.now() < until) {
          const current = yield* mk8s.nodeGroup.get(ngId)
          if (!(current.status?.reconciling ?? false)) return
          console.log(`  (${label}) waiting for the in-flight reconcile to finish: ${JSON.stringify(counts(current))}`)
          yield* sleep(20)
        }
      })

    const sample = (label: string, seconds: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const rows: unknown[] = []
        for (const [index, at] of seconds.entries()) {
          if (index > 0) yield* sleep(at - (seconds[index - 1] ?? 0))
          const fresh = yield* mk8s.nodeGroup.get(ngId)
          const row = { t: `+${at}s`, ...counts(fresh), instances: yield* instanceWitness(compute) }
          rows.push(row)
          console.log(`  ${label} ${JSON.stringify(row)}`)
        }
        return rows
      })

    const push = (label: string, payload: Record<string, unknown>) =>
      Effect.gen(function* () {
        const before = yield* mk8s.nodeGroup.get(ngId)
        return yield* mk8s.nodeGroup
          .update({
            metadata: { id: ngId, resourceVersion: before.metadata!.resourceVersion.toString() },
            spec: NodeGroupSpec.fromJSON(payload),
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
      })

    // ── Arm CONTROL: a template change the service rolls out for ────────────
    // Both witnesses are read: the counter (`outdatedNodeCount`) and the compute instance set (a
    // replacement changes the id). Candidates are tried in order; the first the API accepts wins.
    console.log(`\n${'─'.repeat(78)}\nARM CONTROL: a template change that should roll the nodes out\n${'─'.repeat(78)}`)
    const candidates: Array<{ label: string; platform: string; preset: string }> = [
      ...platforms.filter((platform) => platform !== PLATFORM).map((platform) => ({
        label: `platform ${PLATFORM} → ${platform}`,
        platform,
        preset: PRESET,
      })),
      { label: `preset ${PRESET} → 4vcpu-16gb (same platform)`, platform: PLATFORM, preset: '4vcpu-16gb' },
    ]
    let control: { label: string; rows: unknown[] } | undefined
    for (const candidate of candidates) {
      console.log(`\n  trying: ${candidate.label}`)
      const accepted = yield* push('', {
        version: nodeVersion,
        fixedNodeCount: 1,
        template: template({ resources: { platform: candidate.platform, preset: candidate.preset } }),
      })
      if (accepted === undefined) continue
      control = { label: candidate.label, rows: yield* sample('CONTROL', CONTROL_SAMPLE_SECONDS) }
      break
    }
    if (control === undefined) {
      console.log('  all control candidates were rejected — no positive control available this run')
    } else {
      log(`CONTROL result — ${control.label}`, { rows: control.rows, baselineInstances })
    }

    // ── Arm FS: attach a real shared filesystem by update ──────────────────
    console.log(`\n${'─'.repeat(78)}\nARM FS: template.filesystems (create a Filesystem, attach it)\n${'─'.repeat(78)}`)
    const filesystem = yield* compute.filesystem.create({
      metadata: { parentId: PROJECT_ID, name: FILESYSTEM_NAME },
      spec: FilesystemSpec.fromJSON({
        sizeGibibytes: 100,
        blockSizeBytes: 4096,
        type: 'NETWORK_SSD',
      }),
    })
    filesystemId = filesystem.metadata!.id
    console.log(`  filesystem created: ${filesystemId} (${filesystem.metadata?.name})`)

    yield* settle('before FS attach')
    const freshNg = yield* mk8s.nodeGroup.get(ngId)
    const accepted = yield* push('', {
      version: freshNg.spec?.version === undefined || freshNg.spec.version === '' ? nodeVersion : freshNg.spec.version,
      fixedNodeCount: freshNg.spec?.fixedNodeCount?.toNumber() ?? 1,
      ...(freshNg.spec?.autoscaling === undefined ? {} : { autoscaling: autoscalingJson(freshNg.spec.autoscaling) }),
      template: {
        ...(templateJson(freshNg.spec?.template) as Record<string, unknown>),
        filesystems: [{ attachMode: 'READ_WRITE', mountTag: 'probe-fs', existingFilesystem: { id: filesystemId } }],
      },
    })
    const fsRows = accepted === undefined ? [] : yield* sample('FS', FS_SAMPLE_SECONDS)
    const afterFs = yield* mk8s.nodeGroup.get(ngId)
    log('FS arm — the echo (the enum must be READ_WRITE, i.e. 2 — not the string, not 0)', {
      filesystems: afterFs.spec?.template?.filesystems?.map((attachment) =>
        NodeGroupSchema.AttachedFilesystemSpec.toJSON(attachment),
      ),
      attachModeName:
        afterFs.spec?.template?.filesystems?.[0]?.attachMode === undefined
          ? null
          : NodeGroupSchema.attachedFilesystemSpec_AttachModeToJSON(
              afterFs.spec.template.filesystems[0].attachMode,
            ),
      mountTag: afterFs.spec?.template?.filesystems?.[0]?.mountTag ?? null,
      filesystemId: afterFs.spec?.template?.filesystems?.[0]?.existingFilesystem?.id ?? null,
      status: counts(afterFs),
      samples: fsRows,
    })
    log('FINAL spec echo', specJson(afterFs.spec))
  }).pipe(
    Effect.ensuring(
      mk8s.cluster
        .delete(clusterId)
        .pipe(
          Effect.tap(() => Effect.sync(() => console.log(`\ncleanup — cluster deleted (cascade): ${clusterId}`))),
          Effect.catch((error) =>
            Effect.sync(() => console.error(`cleanup FAILED — delete the cluster by hand: ${clusterId}: ${String(error)}`)),
          ),
          // The filesystem cannot go while a node still has it attached, so it goes second.
          Effect.flatMap(() =>
            filesystemId === undefined
              ? Effect.void
              : compute.filesystem.delete(filesystemId).pipe(
                  Effect.tap(() => Effect.sync(() => console.log(`cleanup — filesystem deleted: ${filesystemId}`))),
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      console.error(`cleanup FAILED — delete the filesystem by hand: ${filesystemId}: ${String(error)}`),
                    ),
                  ),
                ),
          ),
        ),
    ),
  )

  // ── Postflight: prove nothing leaked ──────────────────────────────────────
  yield* sleep(10)
  const [clustersAfter, instancesAfter, filesystemsAfter] = yield* Effect.all([
    mk8s.cluster.list(PROJECT_ID),
    instanceWitness(compute),
    compute.filesystem.list(PROJECT_ID),
  ])
  log('POSTFLIGHT', {
    clusters: clustersAfter.length,
    instances: instancesAfter,
    filesystems: filesystemsAfter.map((fs) => fs.metadata?.name),
  })
  if (clustersAfter.length > 0 || instancesAfter.length > 0 || filesystemsAfter.length > 0) {
    console.error('LEAK — clean up by hand.')
  }
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
  console.log('\nPROBE DONE')
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
