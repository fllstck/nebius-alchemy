/**
 * Diagnose the `compute/v1 Instance` drift loop found on 2026-09-24.
 *
 * A third, unchanged `alchemy deploy` of the same stack still logged `Plan: 1 to update` and
 * `Updating Nebius.compute.v1.Instance` — so some branch of `instanceSpecDrifted` fires against a spec the
 * provider itself wrote. This fetches the live instance, rebuilds the **same `desired`** the provider
 * builds (`hostedSpecInput` + `InstanceSpec.fromJSON`, exactly what `reconcile` does), and reports
 * **branch by branch** which comparison fires — by calling `instanceDriftBranches` itself, so this script
 * cannot drift away from the provider the way a re-implementation would.
 *
 * Read-only: it fetches, it never writes. Run it while a probe VM is up:
 *
 *   bun spikes/instance-drift-diagnose.ts
 *
 * (The first version printed live leaves and left the branch to inference; the inference named the wrong
 * culprit. Hence the named-branch refactor in `instance.ts`.)
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
import * as InstanceModule from '../modules/resources/compute/v1/instance.ts'
import * as ResourceUtils from '../modules/resources/utilities.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as InstanceSchema from '../schemas/nebius/compute/v1/instance.ts'

import { probeInstanceProps } from './instance-drift-probe-props.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { ComputeGrpcService, ComputeGrpcServiceLive } = ComputeGrpcModule
const { InstanceSpec } = InstanceSchema

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const NAME = process.env.PROBE_INSTANCE_NAME ?? 'alchemy-instance-drift-probe'

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

/** JSON with `Long`s as decimal strings — the API's own rendering, so a diff is readable. */
const toJson = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, nested) =>
      nested !== null &&
      typeof nested === 'object' &&
      (nested as { constructor?: { name?: string } }).constructor?.name === 'Long'
        ? String(nested)
        : nested,
    2,
  )

const program = Effect.gen(function* () {
  const compute = yield* ComputeGrpcService
  const rows = yield* compute.instance.list(PROJECT_ID)
  const found = rows.find((instance) => instance.metadata?.name === NAME)
  if (found === undefined) {
    console.error(`no instance named ${NAME}; found: ${rows.map((r) => r.metadata?.name).join(', ') || '(none)'}`)
    return
  }
  const live = yield* compute.instance.get(found.metadata!.id)
  console.log(`live ${found.metadata!.id} (${NAME}) resourceVersion=${live.metadata?.resourceVersion}`)

  // The provider's own construction, so `desired` here IS the payload an update would send.
  const news = probeInstanceProps()
  const desired = InstanceSpec.fromJSON(InstanceModule.hostedSpecInput(news, undefined))

  console.log(`\ndesired (what the provider would send):\n${toJson(specJson(desired))}`)
  console.log(`\nlive spec:\n${toJson(specJson(live.spec))}`)

  const branches = InstanceModule.instanceDriftBranches(
    live.spec,
    desired,
    news as never,
  )
  console.log(`\nbranch verdicts (${branches.filter(([, drifted]) => drifted).length} firing):`)
  for (const [name, drifted] of branches) {
    console.log(`  ${drifted ? 'DRIFT' : '  ok '}  ${name}`)
  }
  if (branches.every(([, drifted]) => !drifted)) console.log('\nconverged — an idle re-deploy writes nothing')

  // The **pre-fix** comparison, frozen here as history so one run shows both halves: these are the
  // branches that used to compare the whole message, and the 2026-09-24 loop is the fact that the top
  // section reads clean while this one fires. (This is a re-implementation of the *old* expression
  // verbatim — `specDeepEqual` on the whole field — not of the current one, so it cannot drift.)
  console.log('\npre-fix verdicts (whole-message `specDeepEqual`, for the record):')
  const liveSpec = live.spec as unknown as Record<string, unknown>
  const desiredSpec = desired as unknown as Record<string, unknown>
  for (const field of ['resources', 'bootDisk', 'networkInterfaces', 'secondaryDisks', 'filesystems']) {
    const drifted = !ResourceUtils.specDeepEqual(liveSpec[field], desiredSpec[field])
    console.log(`  ${drifted ? 'DRIFT' : '  ok '}  ${field}`)
  }
})

/** The spec rendered through `toJSON` (proto defaults omitted), what an operator would diff. */
const specJson = (spec: unknown): unknown =>
  spec === undefined ? '(absent)' : InstanceSpec.toJSON(spec as InstanceSchema.InstanceSpec)

const layer = ComputeGrpcServiceLive.pipe(
  Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
