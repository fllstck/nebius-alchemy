import * as Effect from 'effect'
import * as NebiusPricingPolicyServiceSchema from '../../schemas/nebius/billing/v1/pricing_policy_service.ts'
import type { PricingPolicy } from '../../schemas/nebius/billing/v1/pricing_policy.ts'
import {
  CreatePricingPolicyRequest,
  DeletePricingPolicyRequest,
  GetPricingPolicyRequest,
  ListPricingPoliciesRequest,
} from '../../schemas/nebius/billing/v1/pricing_policy_service.ts'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata.ts'
import * as GrpcUtils from './grpc-utils.ts'
import { NebiusGrpcTransport } from './GrpcTransport.ts'
import type { CreateInput } from './types.ts'

// ---------------------------------------------------------------------------
// PricingPolicy service (billing/v1)
// ---------------------------------------------------------------------------
//
// The service the `pricing_model` oneof's `spot_pricing_policy { id }` arm names — a project-scoped,
// named billing resource that caps what a preemptible VM may pay (per GPU hour, USD). Its endpoint
// (`pricing-policies.billing-cpl.api.nebius.cloud:443`) is in `modules/endpoints.ts` from the upstream
// catalog at the pinned commit.
//
// **There is deliberately no `update` member**, and that is a measurement rather than an omission
// (`spikes/billing-update-shape-probe.ts`, 2026-09-24): `UpdatePricingPolicyService/Update` answers a
// bare `3 INVALID_ARGUMENT: Request validation error` for **every** documented shape of the request —
// `{metadata: {id, resourceVersion}}`, `{id, parentId, resourceVersion}`, a name-identified metadata, a
// version-less metadata, a re-read `resourceVersion` per attempt, a byte-identical spec, a pricing-only
// spec, a changed price, and the trimmed `"3"` the API itself echoes. The resource also comes back from
// `create` at `resourceVersion: 7`, so it is the platform that writes it during creation, not us.
// Provider #41 therefore plans a **replace** for every spec change (see
// `modules/resources/billing/v1/pricing-policy.ts`), exactly like the other services with no usable
// update path — re-derive this before adding an `update` member.

export type CreatePricingPolicyInput = CreateInput

export interface PricingPolicyService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<PricingPolicy, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** Read by `(parent, name)` — the service takes the shared `common/v1 GetByNameRequest`. */
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<PricingPolicy, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<PricingPolicy>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (
    req: CreatePricingPolicyInput,
  ) => Effect.Effect.Effect<
    PricingPolicy,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

export interface BillingGrpcServiceShape {
  readonly pricingPolicy: PricingPolicyService
}

export class BillingGrpcService extends Effect.Context.Service<BillingGrpcService, BillingGrpcServiceShape>()(
  'BillingGrpcService',
) {}

// ---------------------------------------------------------------------------
// Pagination request builder
// ---------------------------------------------------------------------------

/** Exported so the `pageSize` shape is unit-testable without an engine (the house pattern). */
export const pricingPolicyListRequest = (parentId: string, pageToken: string) =>
  ListPricingPoliciesRequest.fromPartial({ parentId, pageSize: 100, pageToken })

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const BillingGrpcServiceLive = Effect.Layer.effect(
  BillingGrpcService,
  Effect.Effect.gen(function* () {
    const raw = yield* GrpcUtils.makeGrpcService(NebiusPricingPolicyServiceSchema.PricingPolicyServiceClient)
    const transport = yield* NebiusGrpcTransport

    const polled = GrpcUtils.wrapWithOperationPolling(raw, {
      serviceName: 'nebius.billing.v1.PricingPolicyService',
      // `create` is the only polled call: there is no usable `update` (see the file header), and
      // `delete`'s operation is discarded after polling (`forget`), the house convention for a delete
      // whose result nothing reads.
      polling: ['create'],
      forget: ['delete'],
      transport,
      // `GetPricingPolicyRequest` carries `resourceVersion` beyond `id`, so it cannot be built by
      // spreading the id — the same shape as mk8s/compute.
      getRequest: (id) => GetPricingPolicyRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => GetPricingPolicyRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
        create: (req: CreatePricingPolicyInput) => CreatePricingPolicyRequest.fromPartial(req),
        delete: (id: string) => DeletePricingPolicyRequest.fromPartial({ id }),
      },
    }) as unknown as PricingPolicyService

    const list = (parentId: string) =>
      GrpcUtils.paginateAll((req) => raw.list(req), pricingPolicyListRequest, parentId)

    return { pricingPolicy: { ...polled, list } }
  }),
)
