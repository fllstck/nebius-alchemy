import * as Effect from 'effect'
import * as NebiusQuotaAllowanceServiceSchema from '../../schemas/nebius/quotas/v1/quota_allowance_service.ts'
import type { QuotaAllowance } from '../../schemas/nebius/quotas/v1/quota_allowance.ts'
import {
  GetQuotaAllowanceRequest,
  CreateQuotaAllowanceRequest,
  UpdateQuotaAllowanceRequest,
  DeleteQuotaAllowanceRequest,
  ListQuotaAllowancesRequest,
} from '../../schemas/nebius/quotas/v1/quota_allowance_service.ts'
import * as GrpcUtils from './grpc-utils.ts'
import { NebiusGrpcTransport } from './GrpcTransport.ts'
import type { CreateInput, UpdateInput } from './types.ts'

// ---------------------------------------------------------------------------
// QuotaAllowance service
// ---------------------------------------------------------------------------

export type CreateQuotaAllowanceInput = CreateInput

export type UpdateQuotaAllowanceInput = UpdateInput

/**
 * The error channel of a **polled** method: the raw call's errors plus the polling path's.
 *
 * `UnknownServiceError` is the addition R-10 surfaced — `pollOperation` resolves the operation service's
 * endpoint through the registry, and a service missing from it fails there. The interface under-declared
 * this until the blind cast was replaced by `satisfies`.
 */
export type QuotaAllowanceOperationError =
  | GrpcUtils.GrpcError
  | GrpcUtils.OperationFailedError
  | GrpcUtils.GrpcDeadlineExceededError
  | GrpcUtils.UnknownServiceError

export interface QuotaAllowanceService {
  readonly get: (id: string) => Effect.Effect.Effect<QuotaAllowance, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string; region: string }) => Effect.Effect.Effect<QuotaAllowance, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<QuotaAllowance>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (
    req: CreateQuotaAllowanceInput,
  ) => Effect.Effect.Effect<QuotaAllowance, QuotaAllowanceOperationError>
  readonly update: (
    req: UpdateQuotaAllowanceInput,
  ) => Effect.Effect.Effect<QuotaAllowance, QuotaAllowanceOperationError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, QuotaAllowanceOperationError>
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface QuotasGrpcServiceShape {
  readonly quotaAllowance: QuotaAllowanceService
}

export class QuotasGrpcService extends Effect.Context.Service<QuotasGrpcService, QuotasGrpcServiceShape>()('QuotasGrpcService') {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const QuotasGrpcServiceLive = Effect.Layer.effect(
  QuotasGrpcService,
  Effect.Effect.gen(function* () {
    const raw = yield* GrpcUtils.makeGrpcService(NebiusQuotaAllowanceServiceSchema.QuotaAllowanceServiceClient)
    const transport = yield* NebiusGrpcTransport

    const polled = GrpcUtils.wrapWithOperationPolling(raw, {
      serviceName: 'nebius.quotas.v1.QuotaAllowanceService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => GetQuotaAllowanceRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => GetQuotaAllowanceRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string; region: string }) =>
          NebiusQuotaAllowanceServiceSchema.GetByNameRequest.fromPartial(req),
        create: (req: CreateQuotaAllowanceInput) => CreateQuotaAllowanceRequest.fromPartial(req),
        update: (req: UpdateQuotaAllowanceInput) => UpdateQuotaAllowanceRequest.fromPartial(req),
        delete: (id: string) => DeleteQuotaAllowanceRequest.fromPartial({ id }),
      },
    }) satisfies Omit<QuotaAllowanceService, 'list'>

    const list = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => raw.list(req),
        (parentId, pageToken) =>
          ListQuotaAllowancesRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
        parentId,
      )

    return { quotaAllowance: { ...polled, list } }
  }),
)
