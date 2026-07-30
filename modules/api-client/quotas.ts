import * as Effect from 'effect'
import * as NebiusQuotaAllowanceServiceSchema from '../../schemas/nebius/quotas/v1/quota_allowance_service'
import type { QuotaAllowance } from '../../schemas/nebius/quotas/v1/quota_allowance'
import {
  GetQuotaAllowanceRequest,
  CreateQuotaAllowanceRequest,
  UpdateQuotaAllowanceRequest,
  DeleteQuotaAllowanceRequest,
  ListQuotaAllowancesRequest,
} from '../../schemas/nebius/quotas/v1/quota_allowance_service'
import * as GrpcUtils from './grpc-utils'
import { NebiusGrpcTransport } from './GrpcTransport'
import type { CreateInput, UpdateInput } from './types'

// ---------------------------------------------------------------------------
// QuotaAllowance service
// ---------------------------------------------------------------------------

export type CreateQuotaAllowanceInput = CreateInput

export type UpdateQuotaAllowanceInput = UpdateInput

export interface QuotaAllowanceService {
  readonly get: (id: string) => Effect.Effect.Effect<QuotaAllowance, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string; region: string }) => Effect.Effect.Effect<QuotaAllowance, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<QuotaAllowance>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateQuotaAllowanceInput) => Effect.Effect.Effect<QuotaAllowance, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateQuotaAllowanceInput) => Effect.Effect.Effect<QuotaAllowance, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
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
    }) as unknown as QuotaAllowanceService

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
