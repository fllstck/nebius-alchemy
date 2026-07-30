import * as Effect from 'effect'
import * as NebiusSymmetricKeyServiceSchema from '../../schemas/nebius/kms/v1/symmetric_key_service'
import type { SymmetricKey } from '../../schemas/nebius/kms/v1/symmetric_key'
import {
  GetSymmetricKeyRequest,
  CreateSymmetricKeyRequest,
  UpdateSymmetricKeyRequest,
  DeleteSymmetricKeyRequest,
  ListSymmetricKeysRequest,
} from '../../schemas/nebius/kms/v1/symmetric_key_service'
import * as NebiusAsymmetricKeyServiceSchema from '../../schemas/nebius/kms/v1/asymmetric_key_service'
import type { AsymmetricKey } from '../../schemas/nebius/kms/v1/asymmetric_key'
import {
  GetAsymmetricKeyRequest,
  CreateAsymmetricKeyRequest,
  UpdateAsymmetricKeyRequest,
  DeleteAsymmetricKeyRequest,
  ListAsymmetricKeysRequest,
} from '../../schemas/nebius/kms/v1/asymmetric_key_service'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata'
import * as GrpcUtils from './grpc-utils'
import { NebiusGrpcTransport } from './GrpcTransport'
import type { CreateInput, UpdateInput } from './types'

// ---------------------------------------------------------------------------
// Shared input types (identical for symmetric and asymmetric keys)
// ---------------------------------------------------------------------------

export type CreateSymmetricKeyInput = CreateInput
export type UpdateSymmetricKeyInput = UpdateInput
export type CreateAsymmetricKeyInput = CreateInput
export type UpdateAsymmetricKeyInput = UpdateInput

// ---------------------------------------------------------------------------
// Service interfaces
// ---------------------------------------------------------------------------

export interface SymmetricKeyService {
  readonly get: (id: string) => Effect.Effect.Effect<SymmetricKey, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string }) => Effect.Effect.Effect<SymmetricKey, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<SymmetricKey>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateSymmetricKeyInput) => Effect.Effect.Effect<SymmetricKey, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateSymmetricKeyInput) => Effect.Effect.Effect<SymmetricKey, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

export interface AsymmetricKeyService {
  readonly get: (id: string) => Effect.Effect.Effect<AsymmetricKey, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string }) => Effect.Effect.Effect<AsymmetricKey, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<AsymmetricKey>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateAsymmetricKeyInput) => Effect.Effect.Effect<AsymmetricKey, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateAsymmetricKeyInput) => Effect.Effect.Effect<AsymmetricKey, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface KmsGrpcServiceShape {
  readonly symmetricKey: SymmetricKeyService
  readonly asymmetricKey: AsymmetricKeyService
}

export class KmsGrpcService extends Effect.Context.Service<KmsGrpcService, KmsGrpcServiceShape>()('KmsGrpcService') {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const KmsGrpcServiceLive = Effect.Layer.effect(
  KmsGrpcService,
  Effect.Effect.gen(function* () {
    const transport = yield* NebiusGrpcTransport

    // -- SymmetricKey --

    const symmetricRaw = yield* GrpcUtils.makeGrpcService(NebiusSymmetricKeyServiceSchema.SymmetricKeyServiceClient)

    const symmetricPolled = GrpcUtils.wrapWithOperationPolling(symmetricRaw, {
      serviceName: 'nebius.kms.v1.SymmetricKeyService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => GetSymmetricKeyRequest.fromPartial({ id, showScheduledForDeletion: false }),
      mapInput: {
        get: (id: string) => GetSymmetricKeyRequest.fromPartial({ id, showScheduledForDeletion: false }),
        getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
        create: (req: CreateSymmetricKeyInput) => CreateSymmetricKeyRequest.fromPartial(req),
        update: (req: UpdateSymmetricKeyInput) => UpdateSymmetricKeyRequest.fromPartial(req),
        delete: (id: string) => DeleteSymmetricKeyRequest.fromPartial({ id }),
      },
    }) as unknown as SymmetricKeyService

    const listSymmetricKeys = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => symmetricRaw.list(req),
        (parentId, pageToken) =>
          ListSymmetricKeysRequest.fromPartial({ parentId, pageSize: 100, pageToken, showScheduledForDeletion: false }),
        parentId,
      )

    const symmetricKey = { ...symmetricPolled, list: listSymmetricKeys }

    // -- AsymmetricKey --

    const asymmetricRaw = yield* GrpcUtils.makeGrpcService(NebiusAsymmetricKeyServiceSchema.AsymmetricKeyServiceClient)

    const asymmetricPolled = GrpcUtils.wrapWithOperationPolling(asymmetricRaw, {
      serviceName: 'nebius.kms.v1.AsymmetricKeyService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => GetAsymmetricKeyRequest.fromPartial({ id, showScheduledForDeletion: false }),
      mapInput: {
        get: (id: string) => GetAsymmetricKeyRequest.fromPartial({ id, showScheduledForDeletion: false }),
        getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
        create: (req: CreateAsymmetricKeyInput) => CreateAsymmetricKeyRequest.fromPartial(req),
        update: (req: UpdateAsymmetricKeyInput) => UpdateAsymmetricKeyRequest.fromPartial(req),
        delete: (id: string) => DeleteAsymmetricKeyRequest.fromPartial({ id }),
      },
    }) as unknown as AsymmetricKeyService

    const listAsymmetricKeys = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => asymmetricRaw.list(req),
        (parentId, pageToken) =>
          ListAsymmetricKeysRequest.fromPartial({ parentId, pageSize: 100, pageToken, showScheduledForDeletion: false }),
        parentId,
      )

    const asymmetricKey = { ...asymmetricPolled, list: listAsymmetricKeys }

    return { symmetricKey, asymmetricKey }
  }),
)
