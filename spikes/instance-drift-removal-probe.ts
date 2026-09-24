/**
 * Does an update **clear** a repeated disk list? (2026-09-24)
 *
 * The drift-list fix has to decide what an *empty* desired `secondaryDisks`/`filesystems` array means, and
 * the proto cannot answer it: proto3 `repeated` has no presence, so `[]` and "the field is absent" are the
 * same bytes on the wire. Two very different behaviours are consistent with that:
 *
 *   * **leave unchanged** — the same rule every scalar and message here follows (`maxPods`, `version`, the
 *     flat `pricing_model` arms — all measured), so an empty list pins nothing; or
 *   * **spec-authoritative** — "During updates, disks are matched by `name`" reads as "the names in the spec
 *     are the attached set", i.e. an update that omits a disk **detaches and deletes** it.
 *
 * The second would be a data-loss hazard with nothing in the props to warn about it (the provider always
 * sends the full desired spec, so *any* unrelated change — a hostname edit — would carry the omission), and
 * it would flip the comparison: an empty desired list would have to be compared against live rather than
 * ignored. So it gets measured rather than inferred.
 *
 * The probe deploys nothing: it takes a live `compute/v1 Instance` with a managed secondary disk and a
 * pinned `hostname`, sends **two** update arms, and reads back the spec each time:
 *
 *   1. the spec back with `secondaryDisks: []` (a repeated field), and
 *   2. the spec back with `hostname` omitted (a plain scalar).
 *
 * Both are what a removal in the config would send. `status.disk_attachments` plus the project's disk list is
 * the witness that separates "still attached" from "detached but preserved" (let alone deleted), and the
 * scalar arm settles the same question for `hostname`/`recoveryPolicy`/`nvlInstanceGroupId` — which is why
 * the drift list compares those on the **pin side** rather than against the live echo.
 *
 *   bun spikes/instance-drift-removal-probe.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as ComputeGrpcModule from '../modules/api-client/compute.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as InstanceSchema from '../schemas/nebius/compute/v1/instance.ts'

import { INSTANCE_NAME, PROJECT_ID } from './instance-drift-probe-props.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { ComputeGrpcService, ComputeGrpcServiceLive } = ComputeGrpcModule
const { InstanceSpec } = InstanceSchema

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
  const compute = yield* ComputeGrpcService
  const rows = yield* compute.instance.list(PROJECT_ID)
  const found = rows.find((instance) => instance.metadata?.name === INSTANCE_NAME)
  if (found === undefined) {
    console.error(`no instance named ${INSTANCE_NAME} — deploy the probe stack first`)
    return
  }
  const id = found.metadata!.id

  const before = yield* compute.instance.get(id)
  const diskNamesBefore = (yield* compute.disk.list(PROJECT_ID)).map((disk) => disk.metadata?.name ?? '?')
  console.log(`before: resourceVersion=${before.metadata?.resourceVersion}`)
  console.log(`  spec.secondaryDisks: ${describeDisks(before.spec?.secondaryDisks)}`)
  console.log(`  attachments:         ${describeAttachments(before.status)}`)
  console.log(`  disks in project:    ${diskNamesBefore.join(', ')}`)

  // EXACTLY what a removal would send: the live spec, minus the data disk. `secondaryDisks: []` encodes as
  // *absent*, which is the ambiguity this probe exists to resolve.
  console.log('\nARM 1 — sending: spec = live spec with `secondaryDisks: []` (encodes as absent)')
  const updated = yield* compute.instance
    .update({
      metadata: {
        id,
        parentId: PROJECT_ID,
        resourceVersion: String(before.metadata!.resourceVersion),
      },
      spec: { ...before.spec!, secondaryDisks: [] },
    })
    .pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  if (typeof updated === 'string') {
    console.log(`  update REJECTED — ${updated}`)
    return
  }

  const after = yield* compute.instance.get(id)
  const diskNamesAfter = (yield* compute.disk.list(PROJECT_ID)).map((disk) => disk.metadata?.name ?? '?')
  console.log(`\nafter:  resourceVersion=${after.metadata?.resourceVersion}`)
  console.log(`  spec.secondaryDisks: ${describeDisks(after.spec?.secondaryDisks)}`)
  console.log(`  attachments:         ${describeAttachments(after.status)}`)
  console.log(`  disks in project:    ${diskNamesAfter.join(', ')}`)

  const kept = (after.spec?.secondaryDisks?.length ?? 0) > 0
  console.log(
    `\nARM 1 VERDICT: an update that omits a managed secondary disk ${kept ? 'LEAVES it attached' : 'DETACHES it'}` +
      `${kept ? ' — "absent ⇒ leave unchanged", like every scalar here' : ' — the disk list is spec-authoritative'}`,
  )

  // ARM 2 — the same question for a plain scalar. `hostname` was pinned when the VM was created (see
  // `PROBE_HOSTNAME`), so an update that omits it is exactly a config that dropped the prop.
  const hostnameBefore = before.spec?.hostname ?? ''
  // Round-trip through JSON so a key can be *removed* (the message is all-optional/`undefined`-valued), and
  // `toJSON` is the API's own rendering — proto defaults dropped, `Long`s as strings.
  const withoutHostname = { ...(InstanceSpec.toJSON(after.spec!) as Record<string, unknown>) }
  delete withoutHostname.hostname
  console.log(`\nARM 2 — sending: spec with \`hostname\` omitted (live holds '${hostnameBefore}')`)
  const scalarUpdate = yield* compute.instance
    .update({
      metadata: {
        id,
        parentId: PROJECT_ID,
        resourceVersion: String(after.metadata!.resourceVersion),
      },
      spec: InstanceSpec.fromJSON(withoutHostname),
    })
    .pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  if (typeof scalarUpdate === 'string') {
    console.log(`  update REJECTED — ${scalarUpdate}`)
    return
  }
  const afterScalar = yield* compute.instance.get(id)
  const hostnameAfter = afterScalar.spec?.hostname ?? ''
  console.log(`\n  resourceVersion=${afterScalar.metadata?.resourceVersion}  spec.hostname='${hostnameAfter}'`)
  console.log(
    `\nARM 2 VERDICT: an omitted scalar ${hostnameAfter === hostnameBefore ? 'is LEFT UNCHANGED' : 'IS cleared'}` +
      `${hostnameAfter === hostnameBefore ? ' — so comparing the live echo against the omitted prop loops forever' : ''}`,
  )
})

const describeDisks = (disks: ReadonlyArray<InstanceSchema.AttachedDiskSpec> | undefined): string =>
  disks === undefined || disks.length === 0
    ? '(empty)'
    : disks.map((disk) => disk.managedDisk?.name ?? disk.existingDisk?.id ?? '?').join(', ')

const describeAttachments = (status: InstanceSchema.InstanceStatus | undefined): string =>
  status?.diskAttachments === undefined || status.diskAttachments.length === 0
    ? '(none)'
    : status.diskAttachments
        .map((a) => `${a.name ?? '?'}${a.isManaged ? ' (managed)' : ''}`)
        .join(', ')

const layer = ComputeGrpcServiceLive.pipe(
  Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
