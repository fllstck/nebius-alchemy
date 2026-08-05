/** M3: standalone access-key create for a harness-created SA (separate process). */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Exit from 'effect/Exit'
import { execSync } from 'node:child_process'
import { NebiusGrpcTransportLive } from './modules/api-client/GrpcTransport.ts'
import { IamGrpcService, IamGrpcServiceLive } from './modules/api-client/iam.ts'
import * as Aks from './schemas/nebius/iam/v2/access_key_service.ts'
import * as Aks2 from './schemas/nebius/iam/v2/access_key.ts'
import { Account } from './schemas/nebius/iam/v1/access.ts'
import { NebiusCredentials } from './modules/Credentials.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!
const SA_ID = process.env.HARNESS_SA_ID!
const TOKEN = execSync('nebius iam get-access-token').toString().trim()

const program = Effect.gen(function* () {
  const iam = yield* IamGrpcService
  // Confirm the SA exists first
  try {
    execSync(`nebius iam service-account get --id ${SA_ID}`, { stdio: 'pipe' })
    console.log('[XPROC] SA EXISTS')
  } catch {
    console.log('[XPROC] SA MISSING')
    return
  }
  const req = Aks.CreateAccessKeyRequest.fromPartial({
    metadata: { parentId: PROJECT, name: `xproc-${Date.now().toString(36)}` },
    spec: Aks2.AccessKeySpec.fromJSON({
      account: Account.fromPartial({ serviceAccount: { id: SA_ID } }),
      secretDeliveryMode: 'INLINE',
    }),
  })
  const result = yield* Effect.exit(iam.accessKeyV2.create(req))
  if (Exit.isFailure(result)) {
    console.log(`[XPROC] create failed: ${String(result.cause).slice(0, 200)}`)
  } else {
    console.log(`[XPROC] create OK: ${result.value.metadata?.id}`)
    yield* Effect.either(iam.accessKeyV2.delete(result.value.metadata!.id!))
  }
})

const layers = Layer.provide(
  IamGrpcServiceLive,
  Layer.provide(
    NebiusGrpcTransportLive,
    Layer.succeed(NebiusCredentials, Effect.succeed({ apiKey: Redacted.make(TOKEN) })),
  ),
)

Effect.runPromise(Effect.provide(program, layers)).catch((e) => {
  console.error('XPROC ERROR:', String(e).slice(0, 300))
  process.exitCode = 1
})
