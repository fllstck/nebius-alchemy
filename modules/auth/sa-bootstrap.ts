/**
 * One-time interactive bootstrap for the Nebius `sa-key` auth method.
 *
 * Creates the service-account identity + authorized key that the RFC 8693
 * token exchange (`sa-token.ts`) consumes. This is the "producer" side of the
 * flow: a bootstrap credential (the user's existing Nebius CLI login, or a
 * pasted API key) is used exactly once to provision:
 *
 *   1. a service account,
 *   2. a locally-generated RSA-4096 authorized key (only the public key is
 *      uploaded — the private key never leaves the machine),
 *   3. optionally a group + group membership + access permit so the SA can
 *      actually manage the project (without a grant the SA gets
 *      PermissionDenied — the same "no permission" every bare SA hits).
 *
 * Deploy-time only, like `sa-token.ts`. The direct gRPC calls deliberately do
 * NOT go through `NebiusGrpcTransport` (which resolves credentials via the
 * auth provider — circular during a bootstrap); each call carries the
 * bootstrap token as a Bearer header instead.
 */
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import * as grpc from '@grpc/grpc-js'
import * as Endpoints from '../endpoints.ts'
import * as NebiusServiceAccountServiceSchema from '../../schemas/nebius/iam/v1/service_account_service.ts'
import type { ServiceAccount } from '../../schemas/nebius/iam/v1/service_account.ts'
import * as NebiusAuthPublicKeyServiceSchema from '../../schemas/nebius/iam/v1/auth_public_key_service.ts'
import type { AuthPublicKey } from '../../schemas/nebius/iam/v1/auth_public_key.ts'
import * as NebiusAccessSchema from '../../schemas/nebius/iam/v1/access.ts'
import * as NebiusGroupServiceSchema from '../../schemas/nebius/iam/v1/group_service.ts'
import type { Group } from '../../schemas/nebius/iam/v1/group.ts'
import * as NebiusGroupMembershipServiceSchema from '../../schemas/nebius/iam/v1/group_membership_service.ts'
import type { GroupMembership } from '../../schemas/nebius/iam/v1/group_membership.ts'
import * as NebiusAccessPermitServiceSchema from '../../schemas/nebius/iam/v1/access_permit_service.ts'
import type { AccessPermit } from '../../schemas/nebius/iam/v1/access_permit.ts'
import type { SaKey } from './sa-token.ts'

/** Raised when bootstrap provisioning fails (bad token, missing grant role, …). */
export class SaBootstrapError extends Schema.TaggedErrorClass<SaBootstrapError>()('SaBootstrapError', {
  message: Schema.String,
}) {}

/** Optional grant: a group + membership + access permit granting the SA a role. */
export interface BootstrapGrant {
  /** Nebius role ID, e.g. "admin" or "editor". */
  readonly role: string
  /** Resource ID to grant access to (typically the project ID). */
  readonly resourceId: string
}

export interface BootstrapOptions {
  /** Parent project for the new service account. */
  readonly parentId: string
  /** Service account name. */
  readonly serviceAccountName: string
  /** Optional group + membership + access permit (see {@link BootstrapGrant}). */
  readonly grant?: BootstrapGrant
}

/**
 * Generate an RSA-4096 keypair. The IAM API rejects other modulus sizes at
 * authorized-key creation time (verified empirically: 2048 → InvalidArgument).
 */
export const generateKeyPair = (): { publicKeyPem: string; privateKeyPem: string } => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 })
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

// ---------------------------------------------------------------------------
// Direct gRPC helpers (Bearer = bootstrap token, TLS, operation-aware)
// ---------------------------------------------------------------------------

import * as GrpcUtils from '../api-client/grpc-utils.ts'
import type { Operation } from '../../schemas/nebius/common/v1/operation.ts'

const makeChannel = (endpoint: string, token: Redacted.Redacted<string>): grpc.Channel => {
  const ssl = grpc.credentials.createSsl()
  const auth = grpc.credentials.createFromMetadataGenerator((_params, callback) => {
    const metadata = new grpc.Metadata()
    metadata.add('authorization', `Bearer ${Redacted.value(token)}`)
    metadata.add('x-idempotency-key', randomUUID())
    callback(null, metadata)
  })
  return new grpc.Channel(endpoint, grpc.credentials.combineChannelCredentials(ssl, auth), {})
}

/** Minimal transport adapter: a token-authed channel per IAM service. */
const tokenTransport = (token: Redacted.Redacted<string>) => ({
  channelFor: (service: string): Effect.Effect<grpc.Channel, Endpoints.UnknownServiceError> =>
    Endpoints.endpointFor(service).pipe(Effect.map((endpoint) => makeChannel(endpoint, token))),
})

const callUnary = <T>(
  client: grpc.Client,
  invoke: (callback: (error: grpc.ServiceError | null, response: T) => void) => grpc.ClientUnaryCall,
): Effect.Effect<T, SaBootstrapError> =>
  Effect.tryPromise(
    () =>
      new Promise<T>((resolve, reject) => {
        invoke((error, response) => {
          if (error) reject(error)
          else resolve(response)
        })
      }),
  ).pipe(
    Effect.mapError(
      (e) =>
        new SaBootstrapError({
          message: `Nebius IAM bootstrap call failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    ),
  )

/**
 * Create a resource through its long-running operation, poll it to
 * completion, then fetch the created resource and return its ID.
 */
const createViaOperation = <Client extends grpc.Client, Res>(
  token: Redacted.Redacted<string>,
  serviceName: string,
  makeClient: (channel: grpc.Channel) => Client,
  createOp: (client: Client) => Effect.Effect<Operation, SaBootstrapError>,
  getResource: (client: Client) => (resourceId: string) => Effect.Effect<Res, SaBootstrapError>,
): Effect.Effect<string, SaBootstrapError> =>
  Effect.gen(function* () {
    const transport = tokenTransport(token)
    const channel = yield* transport.channelFor(serviceName).pipe(
      Effect.mapError((e) => new SaBootstrapError({ message: `Unknown IAM service: ${e.message}` })),
    )
    try {
      const client = makeClient(channel)
      const op = yield* createOp(client)
      yield* GrpcUtils.pollOperation(op.id, serviceName, transport, {
        deadline: new Date(Date.now() + 60_000),
      }).pipe(
        Effect.mapError((e) => new SaBootstrapError({ message: `Bootstrap operation failed: ${e.message}` })),
      )
      const resource = yield* getResource(client)(op.resourceId)
      return (resource as { metadata?: { id?: string } }).metadata?.id ?? ''
    } finally {
      channel.close()
    }
  })

const createServiceAccount = (
  token: Redacted.Redacted<string>,
  parentId: string,
  name: string,
): Effect.Effect<string, SaBootstrapError> =>
  createViaOperation(
    token,
    'nebius.iam.v1.ServiceAccountService',
    (channel) =>
      new NebiusServiceAccountServiceSchema.ServiceAccountServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      }),
    (client) =>
      callUnary<Operation>(client, (callback) =>
        client.create(
          NebiusServiceAccountServiceSchema.CreateServiceAccountRequest.fromPartial({
            metadata: { parentId, name },
            spec: {},
          }),
          callback,
        ),
      ),
    (client) => (resourceId) =>
      callUnary<ServiceAccount>(client, (callback) =>
        client.get(NebiusServiceAccountServiceSchema.GetServiceAccountRequest.fromPartial({ id: resourceId }), callback),
      ),
  )

const createAuthPublicKey = (
  token: Redacted.Redacted<string>,
  parentId: string,
  serviceAccountId: string,
  name: string,
  publicKeyPem: string,
): Effect.Effect<string, SaBootstrapError> =>
  createViaOperation(
    token,
    'nebius.iam.v1.AuthPublicKeyService',
    (channel) =>
      new NebiusAuthPublicKeyServiceSchema.AuthPublicKeyServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      }),
    (client) =>
      callUnary<Operation>(client, (callback) =>
        client.create(
          NebiusAuthPublicKeyServiceSchema.CreateAuthPublicKeyRequest.fromPartial({
            metadata: { parentId, name },
            spec: {
              account: NebiusAccessSchema.Account.fromPartial({ serviceAccount: { id: serviceAccountId } }),
              data: publicKeyPem,
              description: `Alchemy bootstrap key for ${serviceAccountId}`,
            },
          }),
          callback,
        ),
      ),
    (client) => (resourceId) =>
      callUnary<AuthPublicKey>(client, (callback) =>
        client.get(
          NebiusAuthPublicKeyServiceSchema.GetAuthPublicKeyRequest.fromPartial({ id: resourceId }),
          callback,
        ),
      ),
  )

const createGroup = (
  token: Redacted.Redacted<string>,
  parentId: string,
  name: string,
): Effect.Effect<string, SaBootstrapError> =>
  createViaOperation(
    token,
    'nebius.iam.v1.GroupService',
    (channel) =>
      new NebiusGroupServiceSchema.GroupServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      }),
    (client) =>
      callUnary<Operation>(client, (callback) =>
        client.create(NebiusGroupServiceSchema.CreateGroupRequest.fromPartial({ metadata: { parentId, name } }), callback),
      ),
    (client) => (resourceId) =>
      callUnary<Group>(client, (callback) =>
        client.get(NebiusGroupServiceSchema.GetGroupRequest.fromPartial({ id: resourceId }), callback),
      ),
  )

const addGroupMember = (
  token: Redacted.Redacted<string>,
  groupId: string,
  memberId: string,
): Effect.Effect<void, SaBootstrapError> =>
  createViaOperation(
    token,
    'nebius.iam.v1.GroupMembershipService',
    (channel) =>
      new NebiusGroupMembershipServiceSchema.GroupMembershipServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      }),
    (client) =>
      callUnary<Operation>(client, (callback) =>
        client.create(
          NebiusGroupMembershipServiceSchema.CreateGroupMembershipRequest.fromPartial({
            metadata: { parentId: groupId },
            spec: { memberId },
          }),
          callback,
        ),
      ),
    (client) => (resourceId) =>
      callUnary<GroupMembership>(client, (callback) =>
        client.get(
          NebiusGroupMembershipServiceSchema.GetGroupMembershipRequest.fromPartial({ id: resourceId }),
          callback,
        ),
      ),
  ).pipe(Effect.asVoid)

const createAccessPermit = (
  token: Redacted.Redacted<string>,
  groupId: string,
  resourceId: string,
  role: string,
): Effect.Effect<void, SaBootstrapError> =>
  createViaOperation(
    token,
    'nebius.iam.v1.AccessPermitService',
    (channel) =>
      new NebiusAccessPermitServiceSchema.AccessPermitServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      }),
    (client) =>
      callUnary<Operation>(client, (callback) =>
        client.create(
          NebiusAccessPermitServiceSchema.CreateAccessPermitRequest.fromPartial({
            // AccessPermit's parent is the GROUP (not the project) — see AGENTS.md.
            metadata: { parentId: groupId },
            spec: { resourceId, role },
          }),
          callback,
        ),
      ),
    (client) => (resourceId) =>
      callUnary<AccessPermit>(client, (callback) =>
        client.get(NebiusAccessPermitServiceSchema.GetAccessPermitRequest.fromPartial({ id: resourceId }), callback),
      ),
  ).pipe(Effect.asVoid)

// ---------------------------------------------------------------------------
// Bootstrap orchestration
// ---------------------------------------------------------------------------

const bootstrapWithToken = (
  token: Redacted.Redacted<string>,
  options: BootstrapOptions,
): Effect.Effect<SaKey, SaBootstrapError> =>
  Effect.gen(function* () {
    const { publicKeyPem, privateKeyPem } = generateKeyPair()
    const serviceAccountId = yield* createServiceAccount(token, options.parentId, options.serviceAccountName)
    const keyId = yield* createAuthPublicKey(
      token,
      options.parentId,
      serviceAccountId,
      `${options.serviceAccountName}-key`,
      publicKeyPem,
    )
    if (options.grant) {
      const groupId = yield* createGroup(token, options.parentId, `${options.serviceAccountName}-group`)
      yield* addGroupMember(token, groupId, serviceAccountId)
      yield* createAccessPermit(token, groupId, options.grant.resourceId, options.grant.role)
    }
    return { serviceAccountId, keyId, privateKey: privateKeyPem }
  })

/**
 * Service that provisions the SA identity + key material from a one-time
 * bootstrap token. A Context service so the interactive flow in
 * `AuthProvider.ts` is testable with a fake.
 */
export class SaBootstrap extends Context.Service<
  SaBootstrap,
  {
    readonly bootstrap: (
      token: Redacted.Redacted<string>,
      options: BootstrapOptions,
    ) => Effect.Effect<SaKey, SaBootstrapError>
  }
>()('SaBootstrap') {}

export const SaBootstrapLive = Layer.succeed(SaBootstrap, {
  bootstrap: (token, options): Effect.Effect<SaKey, SaBootstrapError> => bootstrapWithToken(token, options),
})
