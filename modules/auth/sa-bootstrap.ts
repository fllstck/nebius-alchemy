/**
 * One-time interactive bootstrap for the Nebius `sa-key` auth method.
 *
 * Creates the service-account identity + authorized key that the RFC 8693
 * token exchange (`sa-token.ts`) consumes. This is the "producer" side of the
 * flow: a bootstrap credential (the current browser OAuth login, or a
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
import * as NebiusProjectServiceSchema from '../../schemas/nebius/iam/v2/project_service.ts'
import type { Project } from '../../schemas/nebius/iam/v2/project.ts'
import * as NebiusTenantServiceSchema from '../../schemas/nebius/iam/v1/tenant_service.ts'
import type { SaKey } from './sa-token.ts'

/** Raised when bootstrap provisioning fails (bad token, missing grant role, …). */
export class SaBootstrapError extends Schema.TaggedError<SaBootstrapError>()('SaBootstrapError', {
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

/**
 * Render a rejection from a `@grpc/grpc-js` unary call as `STATUS (code): details`.
 *
 * The **thunk** form of `Effect.tryPromise` routes every rejection through
 * Effect's `UnknownError`, whose message is the generic "An error occurred in
 * Effect.tryPromise" — so the gRPC status and details were swallowed exactly
 * when a failed bootstrap needed to be diagnosable (that string named neither
 * the call nor the reason). Hence the object form in {@link callUnary} plus this
 * renderer.
 */
const describeCallFailure = (cause: unknown): string => {
  if (typeof cause === 'object' && cause !== null) {
    const { code, details, message } = cause as { code?: unknown; details?: unknown; message?: unknown }
    const numericCode = typeof code === 'number' ? code : undefined
    const statusName = numericCode === undefined ? undefined : grpc.status[numericCode]
    const status =
      numericCode === undefined
        ? undefined
        : typeof statusName === 'string' && statusName.length > 0
          ? `${statusName} (${numericCode})`
          : String(numericCode)
    // `details` is the server's own text; `message` normally repeats it.
    const text =
      typeof details === 'string' && details.length > 0
        ? details
        : typeof message === 'string' && message.length > 0
          ? message
          : undefined
    const rendered = [status, text].filter((part) => part !== undefined).join(': ')
    if (rendered.length > 0) return rendered
  }
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The two bootstrap failures users actually hit need different fixes, so name
 * the fix rather than leaving a bare status code: the bootstrap credential must
 * be able to create IAM resources and grant roles, so a key without tenant-level
 * admin authenticates fine and still fails here.
 */
const bootstrapHint = (cause: unknown): string => {
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined
  if (code === grpc.status.PERMISSION_DENIED) {
    return (
      ' The bootstrap credential needs IAM write access on the tenant — create service accounts and groups,' +
      ' grant roles. A service-account key outside a tenant-admin group authenticates but cannot bootstrap' +
      ' another service account: use a user OAuth login, or a key from a tenant admin.'
    )
  }
  if (code === grpc.status.UNAUTHENTICATED) {
    return ' The bootstrap credential was rejected — it may be expired or truncated; paste it again.'
  }
  return ''
}

/**
 * The message {@link callUnary} raises for a failed IAM call.
 *
 * Exported so the rendering is unit-testable without a live gRPC failure — the
 * regression it guards is a *message* one: the gRPC status and details must
 * survive into the error, because the bootstrap is the one flow a user cannot
 * debug by re-reading their own props.
 */
export const describeIamCallFailure = (cause: unknown): string =>
  `Nebius IAM bootstrap call failed: ${describeCallFailure(cause)}.${bootstrapHint(cause)}`

const callUnary = <T>(
  client: grpc.Client,
  invoke: (callback: (error: grpc.ServiceError | null, response: T) => void) => grpc.ClientUnaryCall,
): Effect.Effect<T, SaBootstrapError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<T>((resolve, reject) => {
        invoke((error, response) => {
          if (error) reject(error)
          else resolve(response)
        })
      }),
    // Object form ON PURPOSE: the thunk form hands `catch` Effect's
    // `UnknownError` wrapper instead of the gRPC failure — see
    // `describeCallFailure`.
    catch: (cause) => new SaBootstrapError({ message: describeIamCallFailure(cause) }),
  })

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

/**
 * Deactivate an authorized key server-side (the `sa-key` logout path).
 *
 * The call is authenticated with a token minted from the key itself (the
 * RFC 8693 exchange in `sa-token.ts`) — the SA's own token can manage its
 * authorized keys. The long-running Deactivate operation is polled to
 * completion so the key is guaranteed deactivated before the caller reports
 * success. Callers must treat this as best-effort: a failure (including a
 * deactivated/revoked key, or a missing IAM grant on the SA) is surfaced as
 * an error so `logout` can fall back to local-only cleanup.
 */
const deactivateAuthPublicKey = (
  token: Redacted.Redacted<string>,
  keyId: string,
): Effect.Effect<void, SaBootstrapError> =>
  Effect.gen(function* () {
    const transport = tokenTransport(token)
    const channel = yield* transport.channelFor('nebius.iam.v1.AuthPublicKeyService').pipe(
      Effect.mapError((e) => new SaBootstrapError({ message: `Unknown IAM service: ${e.message}` })),
    )
    try {
      const client = new NebiusAuthPublicKeyServiceSchema.AuthPublicKeyServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      })
      const op = yield* callUnary<Operation>(client, (callback) =>
        client.deactivate(
          NebiusAuthPublicKeyServiceSchema.DeactivateAuthPublicKeyRequest.fromPartial({ id: keyId }),
          callback,
        ),
      )
      yield* GrpcUtils.pollOperation(op.id, 'nebius.iam.v1.AuthPublicKeyService', transport, {
        deadline: new Date(Date.now() + 30_000),
      }).pipe(
        Effect.mapError((e) => new SaBootstrapError({ message: `Key deactivation failed: ${e.message}` })),
      )
    } finally {
      channel.close()
    }
  })

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

/**
 * Best-effort project lookup (for friendlier prompts, and to record the
 * tenant). Fails soft — a lookup error must never block the bootstrap.
 *
 * Returns the project's display name AND the tenant it belongs to. The tenant
 * is the project's `metadata.parentId`; Nebius has no dedicated "get tenant for
 * project" call, so this is where the SA-key path learns it. Both come from ONE
 * request because the bootstrap needs both and it happens once.
 *
 * Recording the tenant matters: tenant-scoped operations (project fan-out in
 * `factory.ts`'s `makeTenantScopedList`, tenant-parented resources, the
 * `Nebius.*.action.*` discovery resources) read `NEBIUS_TENANT_ID`, and
 * `alchemy unsafe nuke` is the only place alchemy calls a provider's `list`.
 * An OAuth profile already records it; an SA-key profile historically did not,
 * so those users hit a bare `ConfigError` on exactly those operations.
 */
const getProjectDetailsImpl = (
  token: Redacted.Redacted<string>,
  projectId: string,
): Effect.Effect<{ name?: string; tenantId?: string }, SaBootstrapError> =>
  Effect.gen(function* () {
    const transport = tokenTransport(token)
    const channel = yield* transport.channelFor('nebius.iam.v2.ProjectService').pipe(
      Effect.mapError((e) => new SaBootstrapError({ message: `Unknown IAM service: ${e.message}` })),
    )
    try {
      const client = new NebiusProjectServiceSchema.ProjectServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      })
      return yield* callUnary<Project>(client, (callback) =>
        client.get(NebiusProjectServiceSchema.GetProjectRequest.fromPartial({ id: projectId }), callback),
      ).pipe(
        Effect.result,
        Effect.map((r) =>
          r._tag === 'Success'
            ? { name: r.success.metadata?.name, tenantId: r.success.metadata?.parentId }
            : {},
        ),
      )
    } finally {
      channel.close()
    }
  })

/** List the user's tenants (token-scoped) — used by the OAuth login. */
export const listTenants = (
  token: Redacted.Redacted<string>,
): Effect.Effect<ReadonlyArray<{ id: string; name: string }>, SaBootstrapError> =>
  Effect.gen(function* () {
    const transport = tokenTransport(token)
    const channel = yield* transport.channelFor('nebius.iam.v1.TenantService').pipe(
      Effect.mapError((e) => new SaBootstrapError({ message: `Unknown IAM service: ${e.message}` })),
    )
    try {
      const client = new NebiusTenantServiceSchema.TenantServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      })
      const response = yield* callUnary<NebiusTenantServiceSchema.ListTenantsResponse>(client, (callback) =>
        client.list(NebiusTenantServiceSchema.ListTenantsRequest.fromPartial({ pageSize: 100 }), callback),
      )
      return response.items.map((tenant) => ({
        id: tenant.metadata?.id ?? '',
        name: tenant.metadata?.name ?? '',
      }))
    } finally {
      channel.close()
    }
  })

/** List the user's projects (tenant-scoped) — used by the OAuth project picker. */
export const listProjects = (
  token: Redacted.Redacted<string>,
  tenantId: string,
): Effect.Effect<ReadonlyArray<{ id: string; name: string }>, SaBootstrapError> =>
  Effect.gen(function* () {
    const transport = tokenTransport(token)
    const channel = yield* transport.channelFor('nebius.iam.v2.ProjectService').pipe(
      Effect.mapError((e) => new SaBootstrapError({ message: `Unknown IAM service: ${e.message}` })),
    )
    try {
      const client = new NebiusProjectServiceSchema.ProjectServiceClient('unused', grpc.credentials.createSsl(), {
        channelOverride: channel,
      })
      const response = yield* callUnary<NebiusProjectServiceSchema.ListProjectsResponse>(client, (callback) =>
        client.list(
          NebiusProjectServiceSchema.ListProjectsRequest.fromPartial({
            parentId: tenantId,
            pageSize: 100,
          }),
          callback,
        ),
      )
      return response.items.map((project) => ({
        id: project.metadata?.id ?? '',
        name: project.metadata?.name ?? '',
      }))
    } finally {
      channel.close()
    }
  })

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
    /**
     * Best-effort: the project's display name and the tenant it belongs to
     * (`metadata.parentId`). Returns `{}` rather than failing.
     */
    readonly getProjectDetails: (
      token: Redacted.Redacted<string>,
      projectId: string,
    ) => Effect.Effect<{ name?: string; tenantId?: string }, SaBootstrapError>
    /** Deactivate an authorized key server-side (`sa-key` logout). */
    readonly deactivateKey: (
      token: Redacted.Redacted<string>,
      keyId: string,
    ) => Effect.Effect<void, SaBootstrapError>
    /**
     * The user's tenants (token-scoped) — the OAuth login's first picker.
     *
     * On the SERVICE, not a direct module import, for the same reason
     * `bootstrap`/`getProjectDetails`/`deactivateKey` are: a function reached by
     * `import` has no double, so the whole OAuth-login flow was unreachable in
     * unit tests (and, since the OAuth-login arm is exercised by the mutation
     * campaign, a mutant that routed a test into it would hit the real IAM API).
     */
    readonly listTenants: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<ReadonlyArray<{ id: string; name: string }>, SaBootstrapError>
    /** The projects of a tenant — the OAuth login's second picker. */
    readonly listProjects: (
      token: Redacted.Redacted<string>,
      tenantId: string,
    ) => Effect.Effect<ReadonlyArray<{ id: string; name: string }>, SaBootstrapError>
  }
>()('SaBootstrap') {}

export const SaBootstrapLive = Layer.succeed(SaBootstrap, {
  bootstrap: (token, options): Effect.Effect<SaKey, SaBootstrapError> => bootstrapWithToken(token, options),
  getProjectDetails: (token, projectId): Effect.Effect<{ name?: string; tenantId?: string }, SaBootstrapError> =>
    getProjectDetailsImpl(token, projectId),
  deactivateKey: (token, keyId): Effect.Effect<void, SaBootstrapError> => deactivateAuthPublicKey(token, keyId),
  listTenants,
  listProjects,
})
