/** M3 hypothesis: does the membership create make the SA unresolvable? */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import { execSync } from 'node:child_process'
import { NebiusGrpcTransportLive } from './modules/api-client/GrpcTransport.ts'
import { IamGrpcService, IamGrpcServiceLive } from './modules/api-client/iam.ts'
import { NebiusCredentials } from './modules/Credentials.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!
const EDITORS_GROUP = 'group-e00ee03sdm7ht85b9m'
const TOKEN = execSync('nebius iam get-access-token').toString().trim()

const cliGet = (id: string): string => {
  try {
    execSync(`nebius iam service-account get --id ${id}`, { stdio: 'pipe' })
    return 'EXISTS'
  } catch {
    return 'MISSING'
  }
}

const program = Effect.gen(function* () {
  const iam = yield* IamGrpcService
  const name = `memtest-${Date.now().toString(36)}`
  const sa = yield* iam.serviceAccount.create({
    metadata: { parentId: PROJECT, name },
    spec: { description: 'membership test' },
  })
  const id = sa.metadata!.id!
  console.log(`[MEM] SA id=${id}`)
  console.log(`[MEM] after create: ${cliGet(id)}`)

  const gm = yield* iam.groupMembership.create({
    metadata: { parentId: EDITORS_GROUP },
    spec: { memberId: id },
  })
  console.log(`[MEM] membership id=${gm.metadata?.id}`)
  console.log(`[MEM] after membership: ${cliGet(id)}`)
  yield* Effect.sleep('3 seconds')
  console.log(`[MEM] +3s: ${cliGet(id)}`)

  yield* Effect.either(iam.groupMembership.delete(gm.metadata!.id!))
  yield* Effect.either(iam.serviceAccount.delete(id))
  console.log('[MEM] done')
})

const layers = Layer.provide(
  IamGrpcServiceLive,
  Layer.provide(
    NebiusGrpcTransportLive,
    Layer.succeed(NebiusCredentials, Effect.succeed({ apiKey: Redacted.make(TOKEN) })),
  ),
)

Effect.runPromise(Effect.provide(program, layers)).catch((e) => {
  console.error('MEM ERROR:', String(e).slice(0, 300))
  process.exitCode = 1
})
