/**
 * What does the API do with an **empty label key**? (2026-09-24)
 *
 * TASKS.md's last open validation gap is "only `mk8s` rejects empty label keys; 45 other label maps accept
 * them". Whether a shared plan-time filter is the right fix — or whether it would reject a configuration the
 * platform serves — depends entirely on the API's behaviour, which the proto does not state. Three outcomes,
 * three different fixes:
 *
 *   * **rejected at apply** (`3 INVALID_ARGUMENT …, label key`) → a filter only moves the failure earlier; worth
 *     it, but it is a convenience, and the doc must say so;
 *   * **accepted and dropped** (stored without the key) → the filter prevents a *permanent drift loop*:
 *     `Factory.labelsDrifted` compares your props against the live map, so a key the API refuses to store
 *     fires an update on every reconcile — the exact class fixed on `compute/v1 Instance` today;
 *   * **accepted and stored** → a filter would be *wrong* for this API, and the gap should be closed by
 *     deleting the claim instead.
 *
 * Two services, because the answer decides two different things. `vpc/v1 Network` covers the 44
 * `metadata.labels` maps; **`compute/v1 Disk`** covers the one *other* kind of label map in the package —
 * `mk8s NodeGroup.template.instanceMetadata.labels` is compute metadata, not a Kubernetes label, so the
 * filter that mk8s applies to it should be judged against the compute service, not against Kubernetes.
 *
 * One throwaway `vpc/v1 Network` and one 4 GiB disk (no VM, seconds), everything deleted afterwards:
 *
 *   bun spikes/labels-empty-key-probe.ts
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
import * as VpcGrpcModule from '../modules/api-client/vpc.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as NebiusDiskSchema from '../schemas/nebius/compute/v1/disk.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { VpcGrpcService, VpcGrpcServiceLive } = VpcGrpcModule
const { ComputeGrpcService, ComputeGrpcServiceLive } = ComputeGrpcModule
const { DiskSpec } = NebiusDiskSchema

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const NAME = 'alchemy-empty-label-probe'
const DISK_NAME = 'alchemy-empty-label-probe-disk'

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

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (label: string, value: unknown) =>
  console.log(
    `[${stamp()}] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  )

const program = Effect.gen(function* () {
  const vpc = yield* VpcGrpcService
  const compute = yield* ComputeGrpcService

  const existing = (yield* vpc.network.list(PROJECT_ID)).filter((n) => n.metadata?.name === NAME)
  if (existing.length > 0) {
    console.error('ABORT — a leftover probe network exists; delete it first.')
    return
  }

  // ── ARM A: an empty key, alongside a valid one ────────────────────────────
  const created = yield* vpc.network
    .create({
      metadata: { parentId: PROJECT_ID, name: NAME, labels: { '': 'empty-key', 'ok': 'yes' } },
      spec: {},
    })
    .pipe(
      Effect.tap(() => Effect.sync(() => console.log('    create ACCEPTED'))),
      Effect.catch((error) =>
        Effect.sync(() => {
          log('A. create {"" : empty-key, ok: yes}', `REJECTED — ${String(error).slice(0, 400)}`)
          return undefined
        }),
      ),
    )
  if (created === undefined) {
    console.log('\nVERDICT: the API refuses an empty label key at create — a plan-time filter only moves')
    console.log('         the failure earlier. (It would still be worth having, but it is a convenience.)')
    return
  }

  const id = created.metadata!.id
  const afterCreate = yield* vpc.network.get(id)
  log('A. created, read back', {
    labels: afterCreate.metadata?.labels ?? '(none)',
    emptyKeyStored: Object.hasOwn(afterCreate.metadata?.labels ?? {}, ''),
    resourceVersion: afterCreate.metadata?.resourceVersion?.toString(),
  })

  // ── ARM B: a whitespace-only key, added by an update ──────────────────────
  const update = (labels: Record<string, string>) =>
    Effect.gen(function* () {
      const live = yield* vpc.network.get(id)
      return yield* vpc.network
        .update({
          metadata: { id, resourceVersion: live.metadata!.resourceVersion.toString(), labels },
          spec: {},
        })
        .pipe(
          Effect.tap(() => Effect.sync(() => console.log('    update ACCEPTED'))),
          Effect.catch((error) =>
            Effect.sync(() => {
              log('B. update', `REJECTED — ${String(error).slice(0, 400)}`)
              return undefined
            }),
          ),
        )
    })

  const updated = yield* update({ '  ': 'spaces', 'ok': 'yes' })
  if (updated !== undefined) {
    const afterUpdate = yield* vpc.network.get(id)
    log('B. after an update adding the whitespace key', {
      labels: afterUpdate.metadata?.labels ?? '(none)',
      spaceKeyStored: Object.hasOwn(afterUpdate.metadata?.labels ?? {}, '  '),
      emptyKeyStillThere: Object.hasOwn(afterUpdate.metadata?.labels ?? {}, ''),
    })
  }

  // ── ARM C: the same question for the COMPUTE service ─────────────────────
  // `mk8s NodeGroup.template.instanceMetadata.labels` is compute metadata, and mk8s filters it locally —
  // which is only justified if compute refuses an empty key there. A 4 GiB disk answers it without a VM.
  const disk = yield* compute.disk
    .create({
      metadata: { parentId: PROJECT_ID, name: DISK_NAME, labels: { '': 'empty-key', 'ok': 'yes' } },
      spec: DiskSpec.fromJSON({ type: 'NETWORK_SSD', sizeGibibytes: '4' }),
    })
    .pipe(
      Effect.tap(() => Effect.sync(() => console.log('    disk create ACCEPTED'))),
      Effect.catch((error) =>
        Effect.sync(() => {
          log('C. compute disk, labels {"": …}', `REJECTED — ${String(error).slice(0, 400)}`)
          return undefined
        }),
      ),
    )
  if (disk !== undefined) {
    const diskId = disk.metadata!.id
    const readBack = yield* compute.disk.get(diskId)
    log('C. compute disk created, read back', {
      labels: readBack.metadata?.labels ?? '(none)',
      emptyKeyStored: Object.hasOwn(readBack.metadata?.labels ?? {}, ''),
    })
    yield* compute.disk.delete(diskId)
    yield* Effect.sleep('3 seconds')
  }

  // ── ARM C2/C3: the controls that make arm C mean something ───────────────
  // Without C2 the rejection above could be my request shape rather than the empty key; C3 says whether
  // the predicate should be "empty" or "blank" (`mk8s` uses `key.trim() === ''`).
  const diskArm = (label: string, labels: Record<string, string>) =>
    compute.disk
      .create({
        metadata: { parentId: PROJECT_ID, name: `${DISK_NAME}-${label}`, labels },
        spec: DiskSpec.fromJSON({ type: 'NETWORK_SSD', sizeGibibytes: '4' }),
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => console.log(`    disk(${label}) create ACCEPTED`))),
        Effect.catch((error) =>
          Effect.sync(() => {
            log(`disk(${label})`, `REJECTED — ${String(error).slice(0, 200)}`)
            return undefined
          }),
        ),
        Effect.tap((created) =>
          created === undefined
            ? Effect.void
            : compute.disk.delete(created.metadata!.id).pipe(Effect.andThen(Effect.sleep('2 seconds'))),
        ),
      )

  const control = yield* diskArm('control', { ok: 'yes' })
  log('C2. compute disk with only VALID labels', control === undefined ? 'REJECTED' : 'ACCEPTED')
  const blank = yield* diskArm('blank', { '  ': 'spaces', ok: 'yes' })
  log('C3. compute disk with a WHITESPACE-ONLY key', blank === undefined ? 'REJECTED' : 'ACCEPTED')

  // ── Cleanup ───────────────────────────────────────────────────────────────
  yield* vpc.network.delete(id)
  yield* Effect.sleep('3 seconds')
  const remaining = yield* vpc.network.list(PROJECT_ID)
  const remainingDisks = yield* compute.disk.list(PROJECT_ID)
  log('POSTFLIGHT', {
    probeNetworks: remaining.filter((n) => n.metadata?.name === NAME).length,
    probeDisks: remainingDisks.filter((d) => (d.metadata?.name ?? '').startsWith(DISK_NAME)).length,
  })
  console.log('\nVERDICT: see the read-backs above — if `emptyKeyStored` is true while the creates were')
  console.log('         ACCEPTED, the API stores empty label keys and a plan-time filter would reject a')
  console.log('         configuration the platform serves.')
})

const layer = Layer.mergeAll(
  VpcGrpcServiceLive.pipe(
    Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
  ),
  ComputeGrpcServiceLive.pipe(
    Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
  ),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
