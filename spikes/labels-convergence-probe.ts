/**
 * Do `metadata.labels` on an **update** actually converge?
 *
 * The fleet-wide `labels` decision (AGENTS.md §Convergence) is "create-time only today; converging means
 * merging labels into every update's metadata (30+ sites)". Before touching 35 call sites
 * (`grep -rn '\.update({' modules/resources | wc -l` → 35 in 33 files, none of which sends labels), the
 * question is whether an update's labels do anything at all — because on 2026-09-24
 * `billing/v1 PricingPolicy` turned out to **discard** labels entirely, and if update-path labels are
 * ignored too, the 35-site change would be 35 silent no-ops.
 *
 * Three things, on one throwaway `vpc/v1 Network` (no VM, seconds):
 *
 *   A. create with labels {a: '1'}            → read back: are they stored at all?
 *   B. update with labels {a: '1', b: '2'}    → read back: did `b` appear (does an update *add*)?
 *   C. update with labels {a: '1'}            → read back: did `b` disappear (does an update *remove*)?
 *
 * C is the one with a product consequence: converging labels means a label deleted from config is
 * deleted in the cloud.
 *
 *   bun spikes/labels-convergence-probe.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as IamGrpcModule from '../modules/api-client/iam.ts'
import * as VpcGrpcModule from '../modules/api-client/vpc.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { IamGrpcService, IamGrpcServiceLive } = IamGrpcModule
const { VpcGrpcService, VpcGrpcServiceLive } = VpcGrpcModule

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const NAME = 'alchemy-labels-convergence-probe'

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
  console.log(`[${stamp()}] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

const program = Effect.gen(function* () {
  const vpc = yield* VpcGrpcService

  const networks = yield* vpc.network.list(PROJECT_ID)
  const mine = networks.filter((network) => network.metadata?.name === NAME)
  if (mine.length > 0) {
    console.error('ABORT — a leftover probe network exists; delete it first.')
    return
  }

  // A. create with one label.
  const created = yield* vpc.network.create({
    metadata: { parentId: PROJECT_ID, name: NAME, labels: { 'probe-a': '1' } },
    spec: {},
  })
  const id = created.metadata!.id
  const afterCreate = yield* vpc.network.get(id)
  log('A. created with {probe-a: 1}', {
    labelsReadBack: afterCreate.metadata?.labels ?? '(none)',
    resourceVersion: afterCreate.metadata?.resourceVersion?.toString(),
  })

  // B. update that ADDS a label (same spec — a Network's spec is empty in our provider today).
  const updateOnce = (labels: Record<string, string> | undefined) =>
    Effect.gen(function* () {
      const live = yield* vpc.network.get(id)
      return yield* vpc.network
        .update({
          metadata: {
            id,
            resourceVersion: live.metadata!.resourceVersion.toString(),
            ...(labels === undefined ? {} : { labels }),
          },
          spec: {},
        })
        .pipe(
          Effect.tap(() => Effect.sync(() => console.log('    update ACCEPTED'))),
          Effect.catch((error) =>
            Effect.sync(() => {
              console.log(`    update REJECTED: ${String(error).slice(0, 300)}`)
              return undefined
            }),
          ),
        )
    })

  const added = yield* updateOnce({ 'probe-a': '1', 'probe-b': '2' })
  if (added === undefined) {
    console.log('    (an update that sends labels was refused — the shape may need a parentId, like compute)')
  }
  const afterAdd = yield* vpc.network.get(id)
  log('B. after an update with {probe-a, probe-b}', {
    labelsReadBack: afterAdd.metadata?.labels ?? '(none)',
    resourceVersion: afterAdd.metadata?.resourceVersion?.toString(),
  })

  // C. update that DROPS a label — the product-consequence case.
  yield* updateOnce({ 'probe-a': '1' })
  const afterDrop = yield* vpc.network.get(id)
  log('C. after an update with only {probe-a}', {
    labelsReadBack: afterDrop.metadata?.labels ?? '(none)',
    resourceVersion: afterDrop.metadata?.resourceVersion?.toString(),
  })

  // D. an update with NO labels at all — does the omission clear the map?
  yield* updateOnce(undefined)
  const afterOmit = yield* vpc.network.get(id)
  log('D. after an update with NO labels key', {
    labelsReadBack: afterOmit.metadata?.labels ?? '(none)',
  })

  yield* vpc.network.delete(id)
  console.log(`[${stamp()}] cleanup — network deleted ${id}`)
  yield* Effect.sleep('3 seconds')
  const remaining = yield* vpc.network.list(PROJECT_ID)
  log('POSTFLIGHT', { probeNetworks: remaining.filter((n) => n.metadata?.name === NAME).length })
})


const layer = Layer.mergeAll(VpcGrpcServiceLive, IamGrpcServiceLive).pipe(
  Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
