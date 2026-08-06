import * as Effect from 'effect'
import * as NebiusSecretServiceSchema from '../../schemas/nebius/mysterybox/v1/secret_service.ts'
import type { Secret } from '../../schemas/nebius/mysterybox/v1/secret.ts'
import * as NebiusSecretVersionServiceSchema from '../../schemas/nebius/mysterybox/v1/secret_version_service.ts'
import type { SecretVersion } from '../../schemas/nebius/mysterybox/v1/secret_version.ts'
import {
  GetSecretRequest,
  CreateSecretRequest,
  UpdateSecretRequest,
  DeleteSecretRequest,
  ListSecretsRequest,
} from '../../schemas/nebius/mysterybox/v1/secret_service.ts'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata.ts'
import * as GrpcUtils from './grpc-utils.ts'
import { NebiusGrpcTransport } from './GrpcTransport.ts'
import type { CreateInput, UpdateInput } from './types.ts'

// ---------------------------------------------------------------------------
// Secret service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateSecretInput = CreateInput

export type UpdateSecretInput = UpdateInput

export interface SecretService {
  readonly get: (id: string) => Effect.Effect.Effect<Secret, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (
    parentId: string,
    name: string,
  ) => Effect.Effect.Effect<Secret, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Secret>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  readonly create: (
    req: CreateSecretInput,
  ) => Effect.Effect.Effect<
    Secret,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateSecretInput,
  ) => Effect.Effect.Effect<
    Secret,
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
// SecretVersion service — operation-backed Create/Delete
// ---------------------------------------------------------------------------

export type CreateSecretVersionInput = CreateInput

export interface SecretVersionService {
  readonly get: (id: string) => Effect.Effect.Effect<SecretVersion, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<SecretVersion>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateSecretVersionInput) => Effect.Effect.Effect<SecretVersion, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface MysteryBoxGrpcServiceShape {
  readonly secret: SecretService
  readonly secretVersion: SecretVersionService
}

export class MysteryBoxGrpcService
  extends Effect.Context.Service<MysteryBoxGrpcService, MysteryBoxGrpcServiceShape>()('MysteryBoxGrpcService')
{}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const MysteryBoxGrpcServiceLive = Effect.Layer.effect(
  MysteryBoxGrpcService,
  Effect.Effect.gen(function* () {
    const raw = yield* GrpcUtils.makeGrpcService(NebiusSecretServiceSchema.SecretServiceClient)
    const transport = yield* NebiusGrpcTransport

    const polled = GrpcUtils.wrapWithOperationPolling(raw, {
      serviceName: 'nebius.mysterybox.v1.SecretService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => GetSecretRequest.fromPartial({ id, showScheduledForDeletion: false }),
      mapInput: {
        get: (id: string) => GetSecretRequest.fromPartial({ id, showScheduledForDeletion: false }),
        getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
        create: (req: CreateSecretInput) => CreateSecretRequest.fromPartial(req),
        update: (req: UpdateSecretInput) => UpdateSecretRequest.fromPartial(req),
        delete: (id: string) => DeleteSecretRequest.fromPartial({ id }),
      },
    }) as unknown as SecretService

    const list = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => raw.list(req),
        (parentId, pageToken) =>
          ListSecretsRequest.fromPartial({ parentId, pageSize: 100, pageToken, showScheduledForDeletion: false }),
        parentId,
      )

    // -- SecretVersion
    const svRaw = yield* GrpcUtils.makeGrpcService(NebiusSecretVersionServiceSchema.SecretVersionServiceClient)

    const svPolled = GrpcUtils.wrapWithOperationPolling(svRaw, {
      serviceName: 'nebius.mysterybox.v1.SecretVersionService',
      polling: ['create'],
      forget: ['delete'],
      transport,
      getRequest: (id) =>
        NebiusSecretVersionServiceSchema.GetSecretVersionRequest.fromPartial({
          id,
          showScheduledForDeletion: false,
        }),
      mapInput: {
        get: (id: string) =>
          NebiusSecretVersionServiceSchema.GetSecretVersionRequest.fromPartial({
            id,
            showScheduledForDeletion: false,
          }),
        create: (req: CreateSecretVersionInput) =>
          NebiusSecretVersionServiceSchema.CreateSecretVersionRequest.fromPartial(req),
        delete: (id: string) =>
          NebiusSecretVersionServiceSchema.DeleteSecretVersionRequest.fromPartial({ id }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

    const svList = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => svRaw.list(req),
        (parentId, pageToken) =>
          NebiusSecretVersionServiceSchema.ListSecretVersionsRequest.fromPartial({
            parentId,
            pageSize: 100,
            pageToken,
            showScheduledForDeletion: false,
          }),
        parentId,
      )

    const secretVersion: SecretVersionService = { ...svPolled, list: svList }

    return { secret: { ...polled, list }, secretVersion }
  }),
)
