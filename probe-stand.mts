/** M3 comparison: standalone full sequence with access-key request bytes. */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import { execSync } from 'node:child_process'
import { NebiusGrpcTransportLive } from './modules/api-client/GrpcTransport.ts'
import { IamGrpcService, IamGrpcServiceLive } from './modules/api-client/iam.ts'
import * as Aks from './schemas/nebius/iam/v2/access_key_service.ts'
import * as Aks2 from './schemas/nebius/iam/v2/access_key.ts'
import { Account } from './schemas/nebius/iam/v1/access.ts'
import { NebiusCredentials } from './modules/Credentials.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!
const EDITORS_GROUP = 'group-e00ee03sdm7ht85b9m'
const TOKEN = execSync('nebius iam get-access-token').toString().trim()

const program = Effect.gen(function* () {
  const iam = yield* IamGrpcService
  const t0 = Date.now()
  const name = `stand-${Date.now().toString(36)}`

  const sa = yield* iam.serviceAccount.create({
    metadata: { parentId: PROJECT, name },
    spec: { description: 'standalone' },
  })
  const saId = sa.metadata!.id!
  yield* iam.groupMembership.listMembers(EDITORS_GROUP)
  const gm = yield* iam.groupMembership.create({
    metadata: { parentId: EDITORS_GROUP },
    spec: { memberId: saId },
  })
  const req = Aks.CreateAccessKeyRequest.fromPartial({
    metadata: { parentId: PROJECT, name: `ak-${name}` },
    spec: Aks2.AccessKeySpec.fromJSON({
      account: Account.fromPartial({ serviceAccount: { id: saId } }),
      secretDeliveryMode: 'INLINE',
    }),
  })
  const reqBytes = Buffer.from(Aks.CreateAccessKeyRequest.encode(req).finish()).toString('base64')
  console.log(`[AK-DBG] standalone req=${reqBytes}`)
  const ak = yield* iam.accessKeyV2.create(req)
  console.log(`[STAND] all ok (${Date.now() - t0}ms) ak=${ak.metadata?.id}`)
  yield* iam.accessKeyV2.delete(ak.metadata!.id!)
  yield* iam.groupMembership.delete(gm.metadata!.id!)
  yield* iam.serviceAccount.delete(saId)
  console.log(`[STAND] deletes ok (${Date.now() - t0}ms)`)
})

const layers = Layer.provide(
  IamGrpcServiceLive,
  Layer.provide(
    NebiusGrpcTransportLive,
    Layer.succeed(NebiusCredentials, Effect.succeed({ apiKey: Redacted.make(TOKEN) })),
  ),
)

Effect.runPromise(Effect.provide(program, layers)).catch((e) => {
  console.error('STAND ERROR:', String(e).slice(0, 300))
  process.exitCode = 1
})
