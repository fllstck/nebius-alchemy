import * as Effect from 'effect'
import * as NebiusProjectServiceSchema from '../../schemas/nebius/iam/v2/project_service'
import type { Project } from '../../schemas/nebius/iam/v2/project'
import * as NebiusServiceAccountServiceSchema from '../../schemas/nebius/iam/v1/service_account_service'
import type { ServiceAccount } from '../../schemas/nebius/iam/v1/service_account'
import * as NebiusStaticKeyServiceSchema from '../../schemas/nebius/iam/v1/static_key_service'
import type { StaticKey } from '../../schemas/nebius/iam/v1/static_key'
import * as NebiusAccessKeyV1ServiceSchema from '../../schemas/nebius/iam/v1/access_key_service'
import type { AccessKey } from '../../schemas/nebius/iam/v1/access_key'
import * as NebiusAccessKeyV2Schema from '../../schemas/nebius/iam/v2/access_key'
import * as NebiusAccessKeyV2ServiceSchema from '../../schemas/nebius/iam/v2/access_key_service'
import * as NebiusFederationSchema from '../../schemas/nebius/iam/v1/federation'
import * as NebiusFederationServiceSchema from '../../schemas/nebius/iam/v1/federation_service'
import * as NebiusFederationCertSchema from '../../schemas/nebius/iam/v1/federation_certificate'
import * as NebiusFederationCertServiceSchema from '../../schemas/nebius/iam/v1/federation_certificate_service'
import * as NebiusGroupSchema from '../../schemas/nebius/iam/v1/group'
import * as NebiusGroupServiceSchema from '../../schemas/nebius/iam/v1/group_service'
import * as NebiusAuthPublicKeySchema from '../../schemas/nebius/iam/v1/auth_public_key'
import * as NebiusAuthPublicKeyServiceSchema from '../../schemas/nebius/iam/v1/auth_public_key_service'
import * as NebiusFedCredsSchema from '../../schemas/nebius/iam/v1/federated_credentials'
import * as NebiusFedCredsServiceSchema from '../../schemas/nebius/iam/v1/federated_credentials_service'
import * as NebiusGroupMembershipSchema from '../../schemas/nebius/iam/v1/group_membership'
import * as NebiusGroupMembershipServiceSchema from '../../schemas/nebius/iam/v1/group_membership_service'
import * as NebiusAccessPermitSchema from '../../schemas/nebius/iam/v1/access_permit'
import * as NebiusAccessPermitServiceSchema from '../../schemas/nebius/iam/v1/access_permit_service'
import * as NebiusInvitationSchema from '../../schemas/nebius/iam/v1/invitation'
import * as NebiusInvitationServiceSchema from '../../schemas/nebius/iam/v1/invitation_service'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata'
import * as GrpcUtils from './grpc-utils'
import { NebiusGrpcTransport } from './GrpcTransport'
import type { CreateInput, UpdateInput } from './types'

// ---------------------------------------------------------------------------
// Project service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateProjectInput = CreateInput

export type UpdateProjectInput = UpdateInput

export interface ProjectService {
  readonly get: (id: string) => Effect.Effect.Effect<Project, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Project, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all projects in a tenant (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Project>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateProjectInput,
  ) => Effect.Effect.Effect<
    Project,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateProjectInput,
  ) => Effect.Effect.Effect<
    Project,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// ServiceAccount service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateServiceAccountInput = CreateInput

export type UpdateServiceAccountInput = UpdateInput

export interface ServiceAccountService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<ServiceAccount, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (
    parentId: string,
    name: string,
  ) => Effect.Effect.Effect<ServiceAccount, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all service accounts in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<ServiceAccount>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  readonly create: (
    req: CreateServiceAccountInput,
  ) => Effect.Effect.Effect<
    ServiceAccount,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateServiceAccountInput,
  ) => Effect.Effect.Effect<
    ServiceAccount,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// StaticKey service — non-standard (issue, not create)
// ---------------------------------------------------------------------------

export interface IssueStaticKeyInput {
  readonly metadata: { parentId: string; name?: string; labels?: Record<string, string> }
  readonly spec: {}
}

/** Result of issuing a static key — includes both the key resource and the one-time token. */
export interface StaticKeyWithToken {
  readonly key: StaticKey
  readonly token: string
}

export interface StaticKeyService {
  /** Issue a new static key. Returns the key resource + the one-time token (only available at creation). */
  readonly issue: (
    req: IssueStaticKeyInput,
  ) => Effect.Effect.Effect<
    StaticKeyWithToken,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<StaticKey, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// AccessKey v1 service — non-standard (getById, KeyIdentity delete)
// ---------------------------------------------------------------------------

export interface CreateAccessKeyInput {
  readonly metadata: { parentId: string; name?: string; labels?: Record<string, string> }
  readonly spec: {}
}

export interface UpdateAccessKeyInput {
  readonly metadata: { id: string; resourceVersion?: number | string }
  readonly spec: {}
}

export interface AccessKeyV1Service {
  readonly getById: (
    id: string,
  ) => Effect.Effect.Effect<AccessKey, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** Fetch the one-time secret for an access key. Only available once after creation. */
  readonly getSecretOnce: (
    id: string,
  ) => Effect.Effect.Effect<string, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (
    req: CreateAccessKeyInput,
  ) => Effect.Effect.Effect<
    AccessKey,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateAccessKeyInput,
  ) => Effect.Effect.Effect<
    AccessKey,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// AccessKey v2 service — standard CRUD with operation-backed Create/Update/Delete
// ---------------------------------------------------------------------------

export type CreateAccessKeyV2Input = CreateInput

export type UpdateAccessKeyV2Input = UpdateInput

export interface AccessKeyV2Service {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<
    NebiusAccessKeyV2Schema.AccessKey,
    GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError
  >
  /** Fetch the one-time secret for an access key. Secret is only available once after creation. */
  readonly getSecret: (
    id: string,
  ) => Effect.Effect.Effect<string, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List access keys in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<
    ReadonlyArray<NebiusAccessKeyV2Schema.AccessKey>,
    GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError
  >

  readonly create: (
    req: CreateAccessKeyV2Input,
  ) => Effect.Effect.Effect<
    NebiusAccessKeyV2Schema.AccessKey,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateAccessKeyV2Input,
  ) => Effect.Effect.Effect<
    NebiusAccessKeyV2Schema.AccessKey,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Federation service — standard CRUD
// ---------------------------------------------------------------------------

export type CreateFederationInput = CreateInput

export type UpdateFederationInput = UpdateInput

export interface FederationService {
  readonly get: (id: string) => Effect.Effect.Effect<NebiusFederationSchema.Federation, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string }) => Effect.Effect.Effect<NebiusFederationSchema.Federation, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<NebiusFederationSchema.Federation>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateFederationInput) => Effect.Effect.Effect<NebiusFederationSchema.Federation, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateFederationInput) => Effect.Effect.Effect<NebiusFederationSchema.Federation, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// FederationCertificate service — standard CRUD (list is per-federation)
// ---------------------------------------------------------------------------

export type CreateFederationCertInput = CreateInput
export type UpdateFederationCertInput = UpdateInput

export interface FederationCertificateService {
  readonly get: (id: string) => Effect.Effect.Effect<NebiusFederationCertSchema.FederationCertificate, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly listByFederation: (federationId: string) => Effect.Effect.Effect<ReadonlyArray<NebiusFederationCertSchema.FederationCertificate>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateFederationCertInput) => Effect.Effect.Effect<NebiusFederationCertSchema.FederationCertificate, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateFederationCertInput) => Effect.Effect.Effect<NebiusFederationCertSchema.FederationCertificate, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Group service — standard CRUD (empty spec)
// ---------------------------------------------------------------------------

export type CreateGroupInput = CreateInput
export type UpdateGroupInput = UpdateInput

export interface GroupService {
  readonly get: (id: string) => Effect.Effect.Effect<NebiusGroupSchema.Group, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string }) => Effect.Effect.Effect<NebiusGroupSchema.Group, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<NebiusGroupSchema.Group>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateGroupInput) => Effect.Effect.Effect<NebiusGroupSchema.Group, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateGroupInput) => Effect.Effect.Effect<NebiusGroupSchema.Group, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// AuthPublicKey service — standard CRUD
// ---------------------------------------------------------------------------

export type CreateAuthPublicKeyInput = CreateInput
export type UpdateAuthPublicKeyInput = UpdateInput

export interface AuthPublicKeyService {
  readonly get: (id: string) => Effect.Effect.Effect<NebiusAuthPublicKeySchema.AuthPublicKey, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<NebiusAuthPublicKeySchema.AuthPublicKey>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateAuthPublicKeyInput) => Effect.Effect.Effect<NebiusAuthPublicKeySchema.AuthPublicKey, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateAuthPublicKeyInput) => Effect.Effect.Effect<NebiusAuthPublicKeySchema.AuthPublicKey, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// FederatedCredentials service — standard CRUD
// ---------------------------------------------------------------------------

export type CreateFedCredsInput = CreateInput
export type UpdateFedCredsInput = UpdateInput

export interface FederatedCredentialsService {
  readonly get: (id: string) => Effect.Effect.Effect<NebiusFedCredsSchema.FederatedCredentials, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string }) => Effect.Effect.Effect<NebiusFedCredsSchema.FederatedCredentials, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<NebiusFedCredsSchema.FederatedCredentials>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateFedCredsInput) => Effect.Effect.Effect<NebiusFedCredsSchema.FederatedCredentials, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateFedCredsInput) => Effect.Effect.Effect<NebiusFedCredsSchema.FederatedCredentials, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// GroupMembership service — non-standard (ListMembers, operation-backed Create/Delete)
// ---------------------------------------------------------------------------

export interface CreateGroupMembershipInput {
  readonly metadata: { parentId: string; name: string; labels?: Record<string, string> }
  readonly spec: {}
  readonly revokeAfterHours?: number
}

export interface GroupMembershipService {
  readonly get: (id: string) => Effect.Effect.Effect<NebiusGroupMembershipSchema.GroupMembership, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly listMembers: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<NebiusGroupMembershipSchema.GroupMembership>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateGroupMembershipInput) => Effect.Effect.Effect<NebiusGroupMembershipSchema.GroupMembership, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// AccessPermit service — non-standard (Group parent, Create/Delete operations)
// ---------------------------------------------------------------------------

export interface CreateAccessPermitInput {
  readonly metadata: { parentId: string; name: string; labels?: Record<string, string> }
  readonly spec: {}
}

export interface AccessPermitService {
  readonly get: (id: string) => Effect.Effect.Effect<NebiusAccessPermitSchema.AccessPermit, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<NebiusAccessPermitSchema.AccessPermit>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateAccessPermitInput) => Effect.Effect.Effect<NebiusAccessPermitSchema.AccessPermit, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Invitation service — non-standard (Resend, noSend, operation-backed)
// ---------------------------------------------------------------------------

export interface CreateInvitationInput {
  readonly metadata: { parentId: string; name?: string; labels?: Record<string, string> }
  readonly spec: {}
  readonly noSend?: boolean
  readonly expiresIn?: { seconds: string }
}

export interface UpdateInvitationInput {
  readonly metadata: { id: string; resourceVersion?: string }
  readonly spec: {}
}

export interface InvitationService {
  readonly get: (id: string) => Effect.Effect.Effect<NebiusInvitationSchema.Invitation, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<NebiusInvitationSchema.Invitation>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateInvitationInput) => Effect.Effect.Effect<NebiusInvitationSchema.Invitation, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateInvitationInput) => Effect.Effect.Effect<NebiusInvitationSchema.Invitation, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly resend: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface IamGrpcServiceShape {
  readonly project: ProjectService
  readonly serviceAccount: ServiceAccountService
  readonly staticKey: StaticKeyService
  readonly accessKey: AccessKeyV1Service
  readonly accessKeyV2: AccessKeyV2Service
  readonly federation: FederationService
  readonly federationCertificate: FederationCertificateService
  readonly group: GroupService
  readonly authPublicKey: AuthPublicKeyService
  readonly federatedCredentials: FederatedCredentialsService
  readonly groupMembership: GroupMembershipService
  readonly accessPermit: AccessPermitService
  readonly invitation: InvitationService
}

export class IamGrpcService extends Effect.Context.Service<IamGrpcService, IamGrpcServiceShape>()('IamGrpcService') {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

// -- Project ---------------------------------------------------------------

const makeProjectService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusProjectServiceSchema.ProjectServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v2.ProjectService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusProjectServiceSchema.GetProjectRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusProjectServiceSchema.GetProjectRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) =>
        NebiusProjectServiceSchema.GetProjectByNameRequest.fromPartial(req),
      create: (req: CreateProjectInput) => NebiusProjectServiceSchema.CreateProjectRequest.fromPartial(req),
      update: (req: UpdateProjectInput) => NebiusProjectServiceSchema.UpdateProjectRequest.fromPartial(req),
      delete: (id: string) => NebiusProjectServiceSchema.DeleteProjectRequest.fromPartial({ id, dryRun: false }),
    },
  }) as unknown as ProjectService

  const list = (
    parentId: string,
  ): Effect.Effect.Effect<Project[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusProjectServiceSchema.ListProjectsRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
      parentId,
    )

  return { ...polled, list }
})

// -- ServiceAccount --------------------------------------------------------

const makeServiceAccountService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusServiceAccountServiceSchema.ServiceAccountServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.ServiceAccountService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusServiceAccountServiceSchema.GetServiceAccountRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusServiceAccountServiceSchema.GetServiceAccountRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) =>
        NebiusServiceAccountServiceSchema.GetServiceAccountByNameRequest.fromPartial(req),
      create: (req: CreateServiceAccountInput) =>
        NebiusServiceAccountServiceSchema.CreateServiceAccountRequest.fromPartial(req),
      update: (req: UpdateServiceAccountInput) =>
        NebiusServiceAccountServiceSchema.UpdateServiceAccountRequest.fromPartial(req),
      delete: (id: string) => NebiusServiceAccountServiceSchema.DeleteServiceAccountRequest.fromPartial({ id }),
    },
  }) as unknown as ServiceAccountService

  const list = (
    parentId: string,
  ): Effect.Effect.Effect<ServiceAccount[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusServiceAccountServiceSchema.ListServiceAccountRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list }
})

// -- StaticKey -------------------------------------------------------------

const makeStaticKeyService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusStaticKeyServiceSchema.StaticKeyServiceClient)
  const transport = yield* NebiusGrpcTransport
  const serviceName = 'nebius.iam.v1.StaticKeyService'

  const withOperationPolling = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName,
    polling: [] as const,
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusStaticKeyServiceSchema.GetStaticKeyRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusStaticKeyServiceSchema.GetStaticKeyRequest.fromPartial({ id }),
      delete: (id: string) => NebiusStaticKeyServiceSchema.DeleteStaticKeyRequest.fromPartial({ id }),
    },
  }) as unknown as Pick<StaticKeyService, 'get' | 'delete'>

  // issue is handled manually — it returns IssueStaticKeyResponse (not Operation)
  const issue = (
    req: IssueStaticKeyInput,
  ): Effect.Effect.Effect<
    StaticKeyWithToken,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  > =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Effect.Effect.gen(function* () {
      const response = yield* raw.issue(
        NebiusStaticKeyServiceSchema.IssueStaticKeyRequest.fromPartial(req),
      )
      const token = response.token

      // If there's an operation, poll it and fetch the resulting key
      let key: StaticKey
      if (response.operation) {
        yield* GrpcUtils.pollOperation(response.operation.id, serviceName, transport)
        key = yield* raw.get(
          NebiusStaticKeyServiceSchema.GetStaticKeyRequest.fromPartial({ id: response.operation.resourceId }),
        )
      } else {
        // No operation — the key was created synchronously, try to look it up by name
        // Fall back to getByName if we have a name in the metadata
        const name = req.metadata.name
        if (name) {
          key = yield* raw.getByName(
            NebiusStaticKeyServiceSchema.GetStaticKeyByNameRequest.fromPartial({
              parentId: req.metadata.parentId,
              name,
            }),
          )
        } else {
          return yield* Effect.Effect.die(
            `Static key issue returned no operation and no name to look up. ` +
            `Request: ${JSON.stringify(req)}`,
          )
        }
      }

      return { key, token }
    }) as any

  return { ...withOperationPolling, issue } as unknown as StaticKeyService
})

// -- AccessKey v1 ----------------------------------------------------------

const makeAccessKeyV1Service = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusAccessKeyV1ServiceSchema.AccessKeyServiceClient)
  const transport = yield* NebiusGrpcTransport

  // AccessKeyServiceClient uses `getById` and `getByAwsId` instead of `get`.
  // Create a wrapper that aliases `getById` -> `get` for wrapWithOperationPolling.
  const rawWithGet = { ...raw, get: raw.getById }

  const withOperationPolling = GrpcUtils.wrapWithOperationPolling(rawWithGet, {
    serviceName: 'nebius.iam.v1.AccessKeyService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusAccessKeyV1ServiceSchema.GetAccessKeyByIdRequest.fromPartial({ id }),
    mapInput: {
      getById: (id: string) => NebiusAccessKeyV1ServiceSchema.GetAccessKeyByIdRequest.fromPartial({ id }),
      create: (req: CreateAccessKeyInput) =>
        NebiusAccessKeyV1ServiceSchema.CreateAccessKeyRequest.fromPartial(req),
      update: (req: UpdateAccessKeyInput) =>
        NebiusAccessKeyV1ServiceSchema.UpdateAccessKeyRequest.fromPartial(req),
      delete: (id: string) =>
        NebiusAccessKeyV1ServiceSchema.DeleteAccessKeyRequest.fromPartial({
          id: { id },
        }),
    },
  }) as unknown as Pick<AccessKeyV1Service, 'getById' | 'create' | 'update' | 'delete'>

  // getSecretOnce for fetching the one-time secret
  const getSecretOnce = (
    id: string,
  ): Effect.Effect.Effect<string, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    Effect.Effect.gen(function* () {
      const response = yield* raw.getSecretOnce(
        NebiusAccessKeyV1ServiceSchema.GetAccessKeySecretOnceRequest.fromPartial({ id }),
      )
      return response.secret
    })

  return { ...withOperationPolling, getSecretOnce } as unknown as AccessKeyV1Service
})

// -- AccessKey v2 ----------------------------------------------------------

const makeAccessKeyV2Service = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusAccessKeyV2ServiceSchema.AccessKeyServiceClient)
  const transport = yield* NebiusGrpcTransport

  const withOperationPolling = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v2.AccessKeyService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusAccessKeyV2ServiceSchema.GetAccessKeyRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusAccessKeyV2ServiceSchema.GetAccessKeyRequest.fromPartial({ id }),
      create: (req: CreateAccessKeyV2Input) =>
        NebiusAccessKeyV2ServiceSchema.CreateAccessKeyRequest.fromPartial(req),
      update: (req: UpdateAccessKeyV2Input) =>
        NebiusAccessKeyV2ServiceSchema.UpdateAccessKeyRequest.fromPartial(req),
      delete: (id: string) => NebiusAccessKeyV2ServiceSchema.DeleteAccessKeyRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  // getSecret for fetching the one-time secret (v2 uses `getSecret`, not `getSecretOnce`)
  const getSecret = (
    id: string,
  ): Effect.Effect.Effect<string, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    Effect.Effect.gen(function* () {
      const response = yield* raw.getSecret(
        NebiusAccessKeyV2ServiceSchema.GetAccessKeySecretRequest.fromPartial({ id }),
      )
      return response.secret
    })

  // list — project-scoped paginated list
  const list = (
    parentId: string,
  ): Effect.Effect.Effect<
    ReadonlyArray<NebiusAccessKeyV2Schema.AccessKey>,
    GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError
  > =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusAccessKeyV2ServiceSchema.ListAccessKeysRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return {
    ...withOperationPolling,
    getSecret,
    list,
  } as unknown as AccessKeyV2Service
})

// -- Federation ------------------------------------------------------------

const makeFederationService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusFederationServiceSchema.FederationServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.FederationService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusFederationServiceSchema.GetFederationRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusFederationServiceSchema.GetFederationRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) =>
        GetByNameRequest.fromPartial(req),
      create: (req: CreateFederationInput) =>
        NebiusFederationServiceSchema.CreateFederationRequest.fromPartial(req),
      update: (req: UpdateFederationInput) =>
        NebiusFederationServiceSchema.UpdateFederationRequest.fromPartial(req),
      delete: (id: string) => NebiusFederationServiceSchema.DeleteFederationRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (parentId: string): Effect.Effect.Effect<NebiusFederationSchema.Federation[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusFederationServiceSchema.ListFederationsRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as FederationService
})

// -- FederationCertificate -------------------------------------------------

const makeFederationCertService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusFederationCertServiceSchema.FederationCertificateServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.FederationCertificateService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusFederationCertServiceSchema.GetFederationCertificateRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusFederationCertServiceSchema.GetFederationCertificateRequest.fromPartial({ id }),
      create: (req: CreateFederationCertInput) =>
        NebiusFederationCertServiceSchema.CreateFederationCertificateRequest.fromPartial(req),
      update: (req: UpdateFederationCertInput) =>
        NebiusFederationCertServiceSchema.UpdateFederationCertificateRequest.fromPartial(req),
      delete: (id: string) =>
        NebiusFederationCertServiceSchema.DeleteFederationCertificateRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const listByFederation = (
    federationId: string,
  ): Effect.Effect.Effect<NebiusFederationCertSchema.FederationCertificate[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.listByFederation(req),
      (federationId, pageToken) =>
        NebiusFederationCertServiceSchema.ListFederationCertificateByFederationRequest.fromPartial({
          federationId,
          pageSize: 100,
          pageToken,
        }),
      federationId,
    )

  return { ...polled, listByFederation } as unknown as FederationCertificateService
})

// -- Group -----------------------------------------------------------------

const makeGroupService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusGroupServiceSchema.GroupServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.GroupService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusGroupServiceSchema.GetGroupRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusGroupServiceSchema.GetGroupRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) =>
        NebiusGroupServiceSchema.GetGroupByNameRequest.fromPartial(req),
      create: (req: CreateGroupInput) => NebiusGroupServiceSchema.CreateGroupRequest.fromPartial(req),
      update: (req: UpdateGroupInput) => NebiusGroupServiceSchema.UpdateGroupRequest.fromPartial(req),
      delete: (id: string) => NebiusGroupServiceSchema.DeleteGroupRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (parentId: string): Effect.Effect.Effect<NebiusGroupSchema.Group[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusGroupServiceSchema.ListGroupsRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as GroupService
})

// -- AuthPublicKey ---------------------------------------------------------

const makeAuthPublicKeyService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusAuthPublicKeyServiceSchema.AuthPublicKeyServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.AuthPublicKeyService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusAuthPublicKeyServiceSchema.GetAuthPublicKeyRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusAuthPublicKeyServiceSchema.GetAuthPublicKeyRequest.fromPartial({ id }),
      create: (req: CreateAuthPublicKeyInput) =>
        NebiusAuthPublicKeyServiceSchema.CreateAuthPublicKeyRequest.fromPartial(req),
      update: (req: UpdateAuthPublicKeyInput) =>
        NebiusAuthPublicKeyServiceSchema.UpdateAuthPublicKeyRequest.fromPartial(req),
      delete: (id: string) => NebiusAuthPublicKeyServiceSchema.DeleteAuthPublicKeyRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (
    parentId: string,
  ): Effect.Effect.Effect<NebiusAuthPublicKeySchema.AuthPublicKey[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusAuthPublicKeyServiceSchema.ListAuthPublicKeyRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as AuthPublicKeyService
})

// -- FederatedCredentials --------------------------------------------------

const makeFedCredsService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusFedCredsServiceSchema.FederatedCredentialsServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.FederatedCredentialsService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusFedCredsServiceSchema.GetFederatedCredentialsRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusFedCredsServiceSchema.GetFederatedCredentialsRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) =>
        NebiusFedCredsServiceSchema.GetByNameFederatedCredentialsRequest.fromPartial(req),
      create: (req: CreateFedCredsInput) =>
        NebiusFedCredsServiceSchema.CreateFederatedCredentialsRequest.fromPartial(req),
      update: (req: UpdateFedCredsInput) =>
        NebiusFedCredsServiceSchema.UpdateFederatedCredentialsRequest.fromPartial(req),
      delete: (id: string) =>
        NebiusFedCredsServiceSchema.DeleteFederatedCredentialsRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (
    parentId: string,
  ): Effect.Effect.Effect<NebiusFedCredsSchema.FederatedCredentials[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusFedCredsServiceSchema.ListFederatedCredentialsRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as FederatedCredentialsService
})

// -- GroupMembership -------------------------------------------------------

const makeGroupMembershipService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusGroupMembershipServiceSchema.GroupMembershipServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.GroupMembershipService',
    polling: ['create'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusGroupMembershipServiceSchema.GetGroupMembershipRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusGroupMembershipServiceSchema.GetGroupMembershipRequest.fromPartial({ id }),
      create: (req: CreateGroupMembershipInput) =>
        NebiusGroupMembershipServiceSchema.CreateGroupMembershipRequest.fromPartial(req),
      delete: (id: string) =>
        NebiusGroupMembershipServiceSchema.DeleteGroupMembershipRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const listMembers = (
    parentId: string,
  ): Effect.Effect.Effect<NebiusGroupMembershipSchema.GroupMembership[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    Effect.Effect.gen(function* () {
      const response = yield* raw.listMembers(
        NebiusGroupMembershipServiceSchema.ListGroupMembershipsRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken: '',
        }),
      )
      // Response uses `memberships` instead of standard `items`
      return (response as { memberships: NebiusGroupMembershipSchema.GroupMembership[] }).memberships || []
    })

  return { ...polled, listMembers } as unknown as GroupMembershipService
})

// -- AccessPermit ----------------------------------------------------------

const makeAccessPermitService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusAccessPermitServiceSchema.AccessPermitServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.AccessPermitService',
    polling: ['create'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusAccessPermitServiceSchema.GetAccessPermitRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusAccessPermitServiceSchema.GetAccessPermitRequest.fromPartial({ id }),
      create: (req: CreateAccessPermitInput) =>
        NebiusAccessPermitServiceSchema.CreateAccessPermitRequest.fromPartial(req),
      delete: (id: string) =>
        NebiusAccessPermitServiceSchema.DeleteAccessPermitRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (
    parentId: string,
  ): Effect.Effect.Effect<NebiusAccessPermitSchema.AccessPermit[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusAccessPermitServiceSchema.ListAccessPermitRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as AccessPermitService
})

// -- Invitation ------------------------------------------------------------

const makeInvitationService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusInvitationServiceSchema.InvitationServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.iam.v1.InvitationService',
    polling: ['create', 'update'],
    forget: ['resend', 'delete'],
    transport,
    getRequest: (id) => NebiusInvitationServiceSchema.GetInvitationRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusInvitationServiceSchema.GetInvitationRequest.fromPartial({ id }),
      create: (req: CreateInvitationInput) =>
        NebiusInvitationServiceSchema.CreateInvitationRequest.fromPartial(req),
      update: (req: UpdateInvitationInput) =>
        NebiusInvitationServiceSchema.UpdateInvitationRequest.fromPartial(req),
      delete: (id: string) => NebiusInvitationServiceSchema.DeleteInvitationRequest.fromPartial({ id }),
      resend: (id: string) => NebiusInvitationServiceSchema.ResendInvitationRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (
    parentId: string,
  ): Effect.Effect.Effect<NebiusInvitationSchema.Invitation[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusInvitationServiceSchema.ListInvitationsRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as InvitationService
})

// -- Live layer ------------------------------------------------------------

export const IamGrpcServiceLive = Effect.Layer.effect(
  IamGrpcService,
  Effect.Effect.gen(function* () {
    const project = yield* makeProjectService
    const serviceAccount = yield* makeServiceAccountService
    const staticKey = yield* makeStaticKeyService
    const accessKey = yield* makeAccessKeyV1Service
    const accessKeyV2 = yield* makeAccessKeyV2Service
    const federation = yield* makeFederationService
    const federationCertificate = yield* makeFederationCertService
    const group = yield* makeGroupService
    const authPublicKey = yield* makeAuthPublicKeyService
    const federatedCredentials = yield* makeFedCredsService
    const groupMembership = yield* makeGroupMembershipService
    const accessPermit = yield* makeAccessPermitService
    const invitation = yield* makeInvitationService

    return { project, serviceAccount, staticKey, accessKey, accessKeyV2, federation, federationCertificate, group, authPublicKey, federatedCredentials, groupMembership, accessPermit, invitation }
  }),
)
