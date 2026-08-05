/**
 * M3 scratch probe — the PROJECT's api-client (GrpcTransport + wrapGrpcClient +
 * wrapWithOperationPolling) STANDALONE, without the alchemy stack/harness.
 * Decisive bisect: if this fails like the integration tests, the api-client
 * wrapper is the difference; if it works, the alchemy stack environment is.
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import { execSync } from 'node:child_process'
import { NebiusGrpcTransportLive } from './modules/api-client/GrpcTransport.ts'
import { IamGrpcService, IamGrpcServiceLive } from './modules/api-client/iam.ts'
import { AccessKeySpec } from './schemas/nebius/iam/v2/access_key.ts'
import { Account } from './schemas/nebius/iam/v1/access.ts'
import { NebiusCredentials } from './modules/Credentials.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!
const EDITORS_GROUP = 'group-e00ee03sdm7ht85b9m'
const TOKEN = execSync('nebius iam get-access-token').toString().trim()
const t0 = Date.now()

const program = Effect.gen(function* () {
  const iam = yield* IamGrpcService

  // 1. SA create via the PRODUCTION api-client (or CLI when SA_FROM_CLI=1)
  const name = `prod-${Date.now().toString(36)}`
  let saId: string
  if (process.env.SA_FROM_CLI === '1') {
    const out = execSync(
      `nebius iam service-account create --parent-id ${PROJECT} --name cli-prod-${Date.now().toString(36)}`,
    ).toString()
    saId = out.match(/id: (serviceaccount-[a-z0-9]+)/)![1]!
    console.log(`[${Date.now() - t0}ms] SA via CLI: ${saId}`)
  } else {
    const sa = yield* iam.serviceAccount.create({
      metadata: { parentId: PROJECT, name },
      spec: { description: 'production api-client probe' },
    })
    saId = sa.metadata!.id!
    console.log(`[${Date.now() - t0}ms] SA via production api-client: ${saId}`)
  }

  // 2. IMMEDIATELY membership into the default editors group
  try {
    const gm = yield* iam.groupMembership.create({
      metadata: { parentId: EDITORS_GROUP },
      spec: { memberId: saId },
    })
    console.log(`[${Date.now() - t0}ms] MEMBERSHIP: OK (${gm.metadata!.id})`)
  } catch (e) {
    console.log(`[${Date.now() - t0}ms] MEMBERSHIP: FAIL — ${String(e).slice(0, 140)}`)
  }

  // 3. IMMEDIATELY v2 access key for the SA — spec via fromJSON (enum-safe,
  //    matching the project's provider).
  try {
    const ak = yield* iam.accessKeyV2.create({
      metadata: { parentId: PROJECT, name: `ak-${name}` },
      spec: AccessKeySpec.fromJSON({
        account: Account.fromPartial({ serviceAccount: { id: saId } }),
        description: 'production api-client probe',
        secretDeliveryMode: 'INLINE',
      }),
    })
    console.log(`[${Date.now() - t0}ms] ACCESSKEY: OK (${ak.metadata!.id})`)
  } catch (e) {
    console.log(`[${Date.now() - t0}ms] ACCESSKEY: FAIL — ${String(e).slice(0, 140)}`)
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
  console.error('PROBE ERROR:', String(e).slice(0, 300))
  process.exitCode = 1
})
