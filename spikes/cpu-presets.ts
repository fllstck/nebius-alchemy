/**
 * Read-only: which CPU (fabric-less) platform/preset pairs does the capacity advisor advertise?
 *
 * Written while the control probe was running, because the node group compatibility matrix for
 * `cpu-d3` offered only `cpu-d3` itself — so a platform *change* has no candidate, and the positive
 * control has to come from a preset change on the same platform. This prints the pairs so the next
 * run can pick a real one instead of guessing.
 *
 *   bun spikes/cpu-presets.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as CapacityGrpcModule from '../modules/api-client/capacity.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { CapacityGrpcService, CapacityGrpcServiceLive } = CapacityGrpcModule

const TENANT_ID = process.env.NEBIUS_TENANT_ID ?? 'tenant-e00xt8cvv67054nhsj'

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
  const capacity = yield* CapacityGrpcService
  const rows = yield* capacity.resourceAdvice.list(TENANT_ID)
  const cpu = rows.filter((row) => (row.spec?.fabric ?? '') === '')
  const pairs = [
    ...new Set(
      cpu.map(
        (row) =>
          `${row.spec?.region}/${row.spec?.computeInstance?.platform ?? '?'}/` +
          `${row.spec?.computeInstance?.preset?.name ?? '(no preset)'}` +
          ` vcpu=${row.spec?.computeInstance?.preset?.resources?.vcpuCount ?? '?'}` +
          ` mem=${row.spec?.computeInstance?.preset?.resources?.memoryGibibytes ?? '?'}`,
      ),
    ),
  ].sort()
  console.log(`CPU advice rows: ${cpu.length} of ${rows.length}`)
  for (const pair of pairs) console.log(`  ${pair}`)
})

const layer = CapacityGrpcServiceLive.pipe(
  Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
)

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
