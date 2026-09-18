import * as Effect from 'effect'
import * as NebiusResourceAdviceServiceSchema from '../../schemas/nebius/capacity/v1/resource_advice_service.ts'
import type { ResourceAdvice } from '../../schemas/nebius/capacity/v1/resource_advice.ts'
import { ListResourceAdviceRequest } from '../../schemas/nebius/capacity/v1/resource_advice_service.ts'
import * as GrpcUtils from './grpc-utils.ts'

// ---------------------------------------------------------------------------
// ResourceAdvice service — read-only
// ---------------------------------------------------------------------------

/**
 * The capacity advisor exposes a single RPC (`list`) and nothing else: no get,
 * no create/update/delete. Rows are **virtual** — they describe the capacity a
 * tenant can actually get for a `(region, fabric, platform, preset)`, and carry
 * no stable resource identity (see AGENTS.md §"Non-standard APIs").
 *
 * Scoping is by **tenant** (`parent_id` is the tenant NID), not by project.
 */
export interface ResourceAdviceService {
  /** List every capacity-advice row for a tenant (paginates automatically). */
  readonly list: (
    tenantId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<ResourceAdvice>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface CapacityGrpcServiceShape {
  readonly resourceAdvice: ResourceAdviceService
}

export class CapacityGrpcService extends Effect.Context.Service<CapacityGrpcService, CapacityGrpcServiceShape>()(
  'CapacityGrpcService',
) {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const CapacityGrpcServiceLive = Effect.Layer.effect(
  CapacityGrpcService,
  Effect.Effect.gen(function* () {
    const raw = yield* GrpcUtils.makeGrpcService(NebiusResourceAdviceServiceSchema.ResourceAdviceServiceClient)

    const list = (tenantId: string) =>
      GrpcUtils.paginateAll(
        (req) => raw.list(req),
        (parentId, pageToken) => ListResourceAdviceRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
        tenantId,
      )

    return { resourceAdvice: { list } }
  }),
)
