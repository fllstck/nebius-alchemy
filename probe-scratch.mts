/**
 * M3 scratch probe — MINIMAL grpc-js client built from scratch (no project
 * transport, no wrapGrpcClient, no channel caching): direct generated proto
 * clients, direct per-call metadata. Isolates whether the IAM resolution quirk
 * is specific to our client implementation or to grpc-js/Node generally.
 *
 * Flow: SA create → poll op → get SA → IMMEDIATELY membership (editors group)
 * + v2 access key for the SA. Prints each result with elapsed times.
 */
import * as grpc from '@grpc/grpc-js'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { ServiceAccountServiceClient, CreateServiceAccountRequest } from './schemas/nebius/iam/v1/service_account_service.ts'
import { GetServiceAccountRequest } from './schemas/nebius/iam/v1/service_account_service.ts'
import { OperationServiceClient, GetOperationRequest } from './schemas/nebius/common/v1/operation_service.ts'
import { GroupMembershipServiceClient, CreateGroupMembershipRequest } from './schemas/nebius/iam/v1/group_membership_service.ts'
import { AccessKeyServiceClient, CreateAccessKeyRequest } from './schemas/nebius/iam/v2/access_key_service.ts'
import { GetAccessKeyRequest } from './schemas/nebius/iam/v2/access_key_service.ts'
import { AccessKeySpec } from './schemas/nebius/iam/v2/access_key.ts'
import { Account } from './schemas/nebius/iam/v1/access.ts'

const ENDPOINT = 'cpl.iam.api.nebius.cloud:443'
const PROJECT = process.env.NEBIUS_PROJECT_ID!
const EDITORS_GROUP = 'group-e00ee03sdm7ht85b9m'
const TOKEN = execSync('nebius iam get-access-token').toString().trim()

const creds = grpc.credentials.createSsl()

// TEST A: our transport's exact channel construction — metadata generator.
const authCreds = grpc.credentials.createFromMetadataGenerator((_params, callback) => {
  const m = new grpc.Metadata()
  m.add('authorization', `Bearer ${TOKEN}`)
  m.add('x-idempotency-key', randomUUID())
  callback(null, m)
})
const genCreds = grpc.credentials.combineChannelCredentials(creds, authCreds)
const USE_GENERATOR = process.env.USE_GENERATOR === '1'
const channelCreds = USE_GENERATOR ? genCreds : creds

/** Per-call metadata: auth + idempotency key (matching the gosdk). */
const md = (): grpc.Metadata => {
  if (USE_GENERATOR) return new grpc.Metadata()
  const m = new grpc.Metadata()
  m.add('authorization', `Bearer ${TOKEN}`)
  m.add('x-idempotency-key', randomUUID())
  return m
}

/** TEST B: our wrapGrpcClient sends a 30s deadline (grpc-timeout header). */
const callOpts = process.env.USE_DEADLINE === '1' ? { deadline: new Date(Date.now() + 30_000) } : undefined

/** TEST E: exact production call form — options as 2nd arg (no Metadata), generator-only. */
const call = <T>(fn: (cb: (err: grpc.ServiceError | null, res: T) => void) => grpc.ClientUnaryCall): Promise<T> =>
  new Promise((resolve, reject) => {
    fn((err, res) => (err ? reject(err) : resolve(res)))
  })
const prodCall = <T>(fn: (cb: (err: grpc.ServiceError | null, res: T) => void) => grpc.ClientUnaryCall): Promise<T> =>
  new Promise((resolve, reject) => {
    const opts = { ...callOpts, waitForReady: true }
    fn((err, res) => (err ? reject(err) : resolve(res)))
    // simulate options-as-2nd-arg by invoking the callback style below
  })

/** Poll an operation until finishedAt is set; fail on non-OK status. */
const waitOp = async (
  opClient: OperationServiceClient,
  opId: string,
  service: string,
): Promise<void> => {
  for (let i = 0; i < 40; i++) {
    const op = await call((cb) =>
      opClient.get(GetOperationRequest.fromPartial({ id: opId }), md(), callOpts ?? {}, cb),
    )
    if (op.finishedAt) {
      if (op.status && op.status.code !== 0) {
        throw new Error(`operation failed: ${op.status.message ?? op.status.code}`)
      }
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`operation ${opId} timed out polling (${service})`)
}

const main = async () => {
  const t0 = Date.now()
  // TEST C: our transport shares ONE channel across all services.
  const shared = process.env.SHARED_CHANNEL === '1'
  const sharedChannel = shared ? new grpc.Channel(ENDPOINT, channelCreds, {}) : undefined
  const mkClient = <T>(c: new (a: string, b: grpc.ChannelCredentials, o?: Partial<grpc.ClientOptions>) => T): T => {
    if (!shared) return new c(ENDPOINT, channelCreds)
    // Pass the shared channel via channelOverride (as our transport does).
    return new c('unused', channelCreds, {
      channelOverride: sharedChannel,
    } as Partial<grpc.ClientOptions>)
  }

  const saClient = mkClient(ServiceAccountServiceClient)
  const opClient = mkClient(OperationServiceClient)

  // 1. SA create — either via the scratch client or via the CLI (SA_FROM_CLI)
  let saId: string
  if (process.env.SA_FROM_CLI === '1') {
    const out = execSync(
      `nebius iam service-account create --parent-id ${PROJECT} --name cli-scratch-${Date.now().toString(36)}`,
    ).toString()
    saId = out.match(/id: (serviceaccount-[a-z0-9]+)/)![1]!
    console.log(`[${Date.now() - t0}ms] SA via CLI: ${saId}`)
  } else {
    const name = `scratch-${Date.now().toString(36)}`
    const saOp = await call((cb) =>
      saClient.create(
        CreateServiceAccountRequest.fromPartial({
          metadata: { parentId: PROJECT, name },
          spec: { description: 'scratch probe' },
        }),
        md(),
        callOpts ?? {},
        cb,
      ),
    )
    console.log(`[${Date.now() - t0}ms] SA create op: ${saOp.id} resource: ${saOp.resourceId}`)
    await waitOp(opClient, saOp.id, 'SA')
    const sa = await call((cb) =>
      saClient.get(GetServiceAccountRequest.fromPartial({ id: saOp.resourceId! }), md(), callOpts ?? {}, cb),
    )
    saId = sa.metadata!.id!
    console.log(`[${Date.now() - t0}ms] SA active: ${saId}`)
  }

  // 2. IMMEDIATELY membership into the default editors group
  const gmClient = mkClient(GroupMembershipServiceClient)
  const gmOp = await call((cb) =>
    gmClient.create(
      CreateGroupMembershipRequest.fromPartial({
        metadata: { parentId: EDITORS_GROUP },
        spec: { memberId: saId },
      }),
      md(),
      cb,
    ),
  )
  try {
    await waitOp(opClient, gmOp.id, 'membership')
    console.log(`[${Date.now() - t0}ms] MEMBERSHIP: OK (${gmOp.resourceId})`)
  } catch (e) {
    console.log(`[${Date.now() - t0}ms] MEMBERSHIP: FAIL — ${String(e).slice(0, 120)}`)
  }

  // 3. IMMEDIATELY v2 access key for the SA
  const akClient = mkClient(AccessKeyServiceClient)
  const akOp = await call((cb) =>
    akClient.create(
      CreateAccessKeyRequest.fromPartial({
        metadata: { parentId: PROJECT, name: `ak-${saId.slice(-12)}` },
        spec: AccessKeySpec.fromJSON({
          account: Account.fromPartial({ serviceAccount: { id: saId } }),
          description: 'scratch probe',
          secretDeliveryMode: 'INLINE',
        }),
      }),
      md(),
      cb,
    ),
  )
  try {
    await waitOp(opClient, akOp.id, 'access key')
    const ak = await call((cb) =>
      akClient.get(GetAccessKeyRequest.fromPartial({ id: akOp.resourceId! }), md(), callOpts ?? {}, cb),
    )
    console.log(`[${Date.now() - t0}ms] ACCESSKEY: OK (${ak.metadata!.id!})`)
  } catch (e) {
    console.log(`[${Date.now() - t0}ms] ACCESSKEY: FAIL — ${String(e).slice(0, 120)}`)
  }

  saClient.close()
  gmClient.close()
  akClient.close()
  opClient.close()
}

main().catch((e) => {
  console.error('PROBE ERROR:', String(e).slice(0, 300))
  process.exitCode = 1
})
