/**
 * Read-only: the platform catalogue — which **presets** exist on `cpu-d3` (and where the platform is
 * offered), straight from `compute/v1 PlatformService/ListPlatforms`.
 *
 * Written for the roll-out control probe: the node-group compatibility matrix for `cpu-d3` lists only
 * `cpu-d3` as a compatible platform, so the positive control ("a template change the service rolls the
 * nodes out for") has to be a **preset** change on the same platform — which requires a real preset
 * name, not a guess. The capacity advisor does not carry CPU presets (its fabric-less rows are GPU
 * platforms), and `PlatformService` is the only service that answers this.
 *
 *   bun spikes/cpu-platform-presets.ts [platform]
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import Long from 'long'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as GrpcUtils from '../modules/api-client/grpc-utils.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as PlatformServiceSchema from '../schemas/nebius/compute/v1/platform_service.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const WANTED = process.argv[2] ?? 'cpu-d3'

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
  const raw = yield* GrpcUtils.makeGrpcService(PlatformServiceSchema.PlatformServiceClient)
  const items = yield* GrpcUtils.paginateAll(
    (req: PlatformServiceSchema.ListPlatformsRequest) => raw.list(req),
    (_parentId: string, pageToken: string) =>
      PlatformServiceSchema.ListPlatformsRequest.fromPartial({
        parentId: PROJECT_ID,
        pageSize: Long.fromNumber(100),
        pageToken,
      }),
    PROJECT_ID,
  )
  console.log(`platforms: ${items.length}`)
  for (const platform of items) {
    const name = platform.metadata?.name ?? '?'
    if (name !== WANTED) continue
    console.log(`\n${name}: ${platform.spec?.presets.length ?? 0} presets`)
    for (const preset of platform.spec?.presets ?? []) {
      console.log(
        `  ${preset.name}  vcpu=${preset.resources?.vcpuCount ?? '?'} mem=${preset.resources?.memoryGibibytes ?? '?'} gpu=${preset.resources?.gpuCount ?? '?'}`,
      )
    }
  }
})

const layer = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
