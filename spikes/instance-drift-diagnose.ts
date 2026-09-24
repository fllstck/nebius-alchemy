/**
 * Diagnose the `compute/v1 Instance` drift loop found on 2026-09-24.
 *
 * A third, unchanged `alchemy deploy` of the same stack still logged `Plan: 1 to update` and
 * `Updating Nebius.compute.v1.Instance` — so some comparison in `instanceSpecDrifted` is true against a spec
 * the provider itself wrote. This fetches the live instance and reports, **field by field**, which of those
 * comparisons fires, so the fix targets the right one (a materialized empty message, a normalized value, or a
 * default the platform fills in).
 *
 *   bun spikes/instance-drift-diagnose.ts
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
import * as ResourceUtils from '../modules/resources/utilities.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as InstanceSchema from '../schemas/nebius/compute/v1/instance.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { ComputeGrpcService, ComputeGrpcServiceLive } = ComputeGrpcModule

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const NAME = process.env.PROBE_INSTANCE_NAME ?? 'instancestoppedprobe-probevm-live-kay-hwaepw6aznhnoggc'

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
  const found = rows.find((instance) => instance.metadata?.name === NAME)
  if (found === undefined) {
    console.error(`no instance named ${NAME}; found: ${rows.map((r) => r.metadata?.name).join(', ')}`)
    return
  }
  const live = yield* compute.instance.get(found.metadata!.id)
  const toJson = (value: unknown) =>
    JSON.stringify(value, (_key, nested) => (nested !== null && typeof nested === 'object' && 'toString' in nested && typeof nested.toString === 'function' && nested.constructor?.name === 'Long' ? nested.toString() : nested), 2)

  console.log('LIVE spec:')
  console.log(toJson(live.spec === undefined ? 'undefined' : InstanceSchema.InstanceSpec.toJSON(live.spec)))
  console.log(`\nkey-by-key vs an *empty* desired (the shape a matching config sends):`)

  const empty = InstanceSchema.InstanceSpec.fromJSON({})
  for (const key of ['resources', 'bootDisk', 'networkInterfaces', 'secondaryDisks', 'filesystems', 'serviceAccountId', 'cloudInitUserData', 'hostname', 'recoveryPolicy', 'stopped', 'nvlInstanceGroupId'])
    console.log(`  ${key}: ${JSON.stringify(toJson((live.spec as unknown as Record<string, unknown>)[key]))}`)
  void empty
  void ResourceUtils
})

const layer = ComputeGrpcServiceLive.pipe(
  Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
