/**
 * Read-only environment inventory: everything a probe could have left behind.
 *
 * Written to answer "there are still nodes running, why?" with facts rather than inference: a running
 * node is either a probe that is deliberately mid-run, or a leak from one that has exited.
 *
 * Widened 2026-09-24, after a session whose probes created a `vpc/v1 Network`, `compute/v1 Disk`s and a
 * `dns/v1 Zone` — none of which this script could see. It now walks every listable family a probe (or a
 * half-failed deploy) can leak into, because "the tenant is empty" is only meaningful if the inventory
 * looks at the resources that were actually created. Read-only: no writes, no spend.
 *
 *   bun spikes/env-inventory.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as BillingGrpcModule from '../modules/api-client/billing.ts'
import * as ComputeGrpcModule from '../modules/api-client/compute.ts'
import * as DnsGrpcModule from '../modules/api-client/dns.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as IamGrpcModule from '../modules/api-client/iam.ts'
import * as KmsGrpcModule from '../modules/api-client/kms.ts'
import * as Mk8sGrpcModule from '../modules/api-client/mk8s.ts'
import * as MysteryboxGrpcModule from '../modules/api-client/mysterybox.ts'
import * as StorageGrpcModule from '../modules/api-client/storage.ts'
import * as VpcGrpcModule from '../modules/api-client/vpc.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import { requireProjectId } from './spike-env.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { Mk8sGrpcService, Mk8sGrpcServiceLive } = Mk8sGrpcModule
const { ComputeGrpcService, ComputeGrpcServiceLive } = ComputeGrpcModule
const { VpcGrpcService, VpcGrpcServiceLive } = VpcGrpcModule
const { DnsGrpcService, DnsGrpcServiceLive } = DnsGrpcModule
const { IamGrpcService, IamGrpcServiceLive } = IamGrpcModule
const { StorageGrpcService, StorageGrpcServiceLive } = StorageGrpcModule
const { KmsGrpcService, KmsGrpcServiceLive } = KmsGrpcModule
const { MysteryBoxGrpcService, MysteryBoxGrpcServiceLive } = MysteryboxGrpcModule
const { BillingGrpcService, BillingGrpcServiceLive } = BillingGrpcModule

const PROJECT_ID = requireProjectId()

/** Anything with proto metadata — every resource in this package. */
interface HasMetadata {
  metadata?: { id?: string; name?: string; createdAt?: unknown } | undefined
  status?: { state?: unknown } | undefined
}

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

/**
 * When the API reports it, the creation time — an orphan's *age* is what identifies the session that left it
 * ("created 2026-09-22" points at the transfer probe; "created today" points at the run you just did).
 * `metadata.createdAt` is a protobuf `Timestamp` (`{ seconds }`), sometimes already a `Date`.
 */
const createdAt = (row: HasMetadata): string => {
  const raw = row.metadata?.createdAt as { seconds?: unknown } | Date | string | undefined
  if (raw === undefined || raw === null) return ''
  const millis =
    raw instanceof Date
      ? raw.getTime()
      : typeof raw === 'string'
        ? Date.parse(raw)
        : raw.seconds === undefined
          ? Number.NaN
          : Number(raw.seconds) * 1000
  return Number.isFinite(millis) ? ` created=${new Date(millis).toISOString().slice(0, 16)}` : ''
}

/**
 * Print a section: the count, then one line per resource. A non-zero count is what "orphan" means.
 *
 * Takes `unknown` rows on purpose: every resource in this package carries proto metadata, but each
 * generated type declares its own `status.state` enum, so a shared structural type fights the compiler for
 * no benefit. The narrowing lives here, once.
 */
const report = (title: string, rows: ReadonlyArray<unknown>, detail?: (row: HasMetadata) => string): void => {
  console.log(`\n${title}: ${rows.length}`)
  for (const entry of rows) {
    const row = entry as HasMetadata
    const state = row.status?.state === undefined ? '' : ` state=${String(row.status.state)}`
    console.log(
      `  ${row.metadata?.name ?? '?'} (${row.metadata?.id ?? '?'})${state}${createdAt(row)}${detail ? ` ${detail(row)}` : ''}`,
    )
  }
}

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService
  const compute = yield* ComputeGrpcService
  const vpc = yield* VpcGrpcService
  const dns = yield* DnsGrpcService
  const iam = yield* IamGrpcService
  const storage = yield* StorageGrpcService
  const kms = yield* KmsGrpcService
  const mysterybox = yield* MysteryBoxGrpcService
  const billing = yield* BillingGrpcService

  console.log(`project ${PROJECT_ID}`)

  // ── mk8s + compute: the families the first version covered ────────────────
  const clusters = yield* mk8s.cluster.list(PROJECT_ID)
  console.log(`\nclusters: ${clusters.length}`)
  for (const cluster of clusters) {
    const id = cluster.metadata?.id ?? '?'
    console.log(
      `  ${cluster.metadata?.name} (${id}) state=${cluster.status?.state} version=${cluster.status?.controlPlane?.version ?? '?'}`,
    )
    const groups = yield* mk8s.nodeGroup
      .list(id)
      .pipe(Effect.catch((error) => Effect.sync(() => `ERROR ${String(error)}` as const)))
    if (typeof groups === 'string') {
      console.log(`    node groups: ${groups}`)
      continue
    }
    for (const group of groups) {
      console.log(
        `    node group ${group.metadata?.name} (${group.metadata?.id}) state=${group.status?.state} ` +
          `target=${group.status?.targetNodeCount} node=${group.status?.nodeCount} ready=${group.status?.readyNodeCount} ` +
          `outdated=${group.status?.outdatedNodeCount} rv=${group.metadata?.resourceVersion}`,
      )
    }
  }

  report('compute instances', yield* compute.instance.list(PROJECT_ID))
  report('disks', yield* compute.disk.list(PROJECT_ID))
  report('disk snapshots', yield* compute.diskSnapshot.list(PROJECT_ID))
  report('filesystems', yield* compute.filesystem.list(PROJECT_ID))
  report('gpu clusters', yield* compute.gpuCluster.list(PROJECT_ID))
  report('nvl instance groups', yield* compute.nvlInstanceGroup.list(PROJECT_ID))

  // ── vpc: networks/subnets are pre-existing (`default-network`), so a non-zero
  // count here is expected — the names tell you whether it is a probe's ───────
  report('vpc networks', yield* vpc.network.list(PROJECT_ID))
  report('vpc subnets', yield* vpc.subnet.list(PROJECT_ID))
  report('vpc route tables', yield* vpc.routeTable.list(PROJECT_ID))
  report('vpc security groups', yield* vpc.securityGroup.list(PROJECT_ID))
  report('vpc route policies (allocations)', yield* vpc.allocation.list(PROJECT_ID))

  // ── dns: zones leak silently — a zone with records cannot be deleted, so a
  // failed probe cleanup leaves both ────────────────────────────────────────
  const zones = yield* dns.zone.list(PROJECT_ID)
  console.log(`\ndns zones: ${zones.length}`)
  for (const zone of zones) {
    const records = yield* dns.record
      .list(zone.metadata!.id)
      .pipe(Effect.catch((error) => Effect.sync(() => `ERROR ${String(error).slice(0, 80)}` as const)))
    const count = typeof records === 'string' ? records : `${records.length} record(s)`
    console.log(`  ${zone.metadata?.name} (${zone.metadata?.id}) ${zone.spec?.domainName ?? ''} — ${count}`)
  }

  // ── iam: probe identities + the keys they minted ─────────────────────────
  report('iam service accounts', yield* iam.serviceAccount.list(PROJECT_ID))
  report('iam access keys (v2)', yield* iam.accessKeyV2.list(PROJECT_ID))
  report('iam static keys (v1)', yield* iam.staticKey.list(PROJECT_ID))
  report('iam auth public keys', yield* iam.authPublicKey.list(PROJECT_ID))
  report('iam federated credentials', yield* iam.federatedCredentials.list(PROJECT_ID))
  report('iam groups', yield* iam.group.list(PROJECT_ID))

  // ── storage, kms, mysterybox, billing ────────────────────────────────────
  report('storage buckets', yield* storage.bucket.list(PROJECT_ID))
  // Transfers get a detail line: unlike everything else here, a transfer **acts** — it moves data per its stop
  // condition, so "left running" is a spend question rather than a tidiness one. The stop condition is the
  // three flat oneof fields the props reshape (`storage/v1 transfer.stopCondition`).
  report('storage transfers', yield* storage.transfer.list(PROJECT_ID), (row) => {
    const spec = (row as { spec?: Record<string, unknown> }).spec
    if (spec === undefined) return ''
    const stop =
      spec.infinite !== undefined
        ? 'stop=infinite (runs until deleted)'
        : spec.afterOneIteration !== undefined
          ? 'stop=afterOneIteration'
          : spec.afterNEmptyIterations !== undefined
            ? `stop=afterNEmptyIterations(${String((spec.afterNEmptyIterations as { count?: unknown }).count)})`
            : 'stop=(none set)'
    const bucket = (side: unknown) => {
      const nebius = (side as { nebius?: { bucketName?: string; bucket?: { name?: string } } } | undefined)?.nebius
      return nebius?.bucketName ?? nebius?.bucket?.name ?? (side === undefined ? '?' : 'external')
    }
    return `${bucket(spec.source)} → ${bucket(spec.destination)} ${stop}`
  })
  report('kms symmetric keys', yield* kms.symmetricKey.list(PROJECT_ID))
  report('kms asymmetric keys', yield* kms.asymmetricKey.list(PROJECT_ID))
  report('mysterybox secrets', yield* mysterybox.secret.list(PROJECT_ID))
  report('billing pricing policies', yield* billing.pricingPolicy.list(PROJECT_ID))
})

// Nine services at once exceed `Layer.mergeAll`'s inference and collapse the requirements to `unknown`
// (seen as "Effect<void, unknown, unknown> is not assignable" at the `provide` below), so they are merged
// in two groups — the same shape, just nested.
const layer = Layer.merge(
  Layer.mergeAll(
    Mk8sGrpcServiceLive,
    ComputeGrpcServiceLive,
    VpcGrpcServiceLive,
    DnsGrpcServiceLive,
    IamGrpcServiceLive,
  ),
  Layer.mergeAll(StorageGrpcServiceLive, KmsGrpcServiceLive, MysteryBoxGrpcServiceLive, BillingGrpcServiceLive),
).pipe(Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))))

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
