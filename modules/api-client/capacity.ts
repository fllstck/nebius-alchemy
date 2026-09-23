import * as Effect from 'effect'
import * as NebiusResourceAdviceServiceSchema from '../../schemas/nebius/capacity/v1/resource_advice_service.ts'
import type { ResourceAdvice } from '../../schemas/nebius/capacity/v1/resource_advice.ts'
import { ListResourceAdviceRequest } from '../../schemas/nebius/capacity/v1/resource_advice_service.ts'
import * as NebiusCapacityBlockGroupServiceSchema from '../../schemas/nebius/capacity/v1/capacity_block_group_service.ts'
import type { CapacityBlockGroup } from '../../schemas/nebius/capacity/v1/capacity_block_group.ts'
import type { ResourceAffinity } from '../../schemas/nebius/capacity/v1/resource_affinity.ts'
import {
  GetCapacityBlockGroupRequest,
  GetCapacityBlockGroupByResourceAffinityRequest,
  ListCapacityBlockGroupsRequest,
  ListCapacityBlockGroupResourcesRequest,
} from '../../schemas/nebius/capacity/v1/capacity_block_group_service.ts'
import * as NebiusCapacityIntervalServiceSchema from '../../schemas/nebius/capacity/v1/capacity_interval_service.ts'
import type { CapacityInterval } from '../../schemas/nebius/capacity/v1/capacity_interval.ts'
import {
  GetCapacityIntervalRequest,
  ListCapacityIntervalsRequest,
} from '../../schemas/nebius/capacity/v1/capacity_interval_service.ts'
import * as NebiusCapacityAllowanceServiceSchema from '../../schemas/nebius/capacity/v1/capacity_allowance_service.ts'
import type { CapacityAllowance } from '../../schemas/nebius/capacity/v1/capacity_allowance.ts'
import {
  GetCapacityAllowanceRequest,
  GetCapacityAllowanceByParentAndCapacityBlockGroupRequest,
  ListCapacityAllowancesRequest,
  ListCapacityAllowancesByCapacityBlockGroupRequest,
} from '../../schemas/nebius/capacity/v1/capacity_allowance_service.ts'
import * as GrpcUtils from './grpc-utils.ts'

// ---------------------------------------------------------------------------
// Capacity — three services, all on the `capacity-blocks` host
// ---------------------------------------------------------------------------
//
// `ENDPOINTS.md` splits the capacity API across two hosts, and `endpoints.ts`
// already carries both:
//
//   capacity-advisor.billing-cpl…  → ResourceAdviceService    (advice)
//   capacity-blocks.billing-cpl…   → CapacityBlockGroupService
//                                    CapacityIntervalService
//                                    CapacityAllowanceService   (these)
//
// ⚠️ **Reachability measured live 2026-09-23** (`spikes/capacity-blocks-probe.ts`,
// read-only): the `capacity-blocks` host authenticates and answers from this
// environment, so no transport work is needed — the generic `makeGrpcService`
// resolves it through the endpoint catalog. The tenant used for the probe has
// **no** capacity block groups (`List` → `{ items: [] }`), which is why every
// scoped call there returns the API's own
// `5 NOT_FOUND: Capacity Block Group (id=…) not found`.
//
// Two facts the services share, both probed rather than assumed:
//
// - `pageSize: 100` is **accepted** by `CapacityBlockGroupService/List`,
//   `CapacityIntervalService/List`, `CapacityAllowanceService/List` and
//   `/ListByCapacityBlockGroup`. That is not a given: `nvl-instance-group`
//   rejects 100 while its compute neighbours accept it (see
//   `tests/api-client/nvl-instance-group-list.test.ts`), so the pagination
//   helpers below were probed before being written this way.
// - Every list here is **parent-scoped**, and the parent is not always the same
//   kind of thing: block groups list by *tenant*, intervals by *block group*,
//   allowances by *project*. Passing a tenant where a block group is expected is
//   rejected with `parent_id: Value error, Expected capacityblockgroup type but
//   got tenant` (probed) — a useful error, and the reason each method below is
//   typed on a named argument rather than a bare `parentId`.

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
// CapacityBlockGroup service — read-only
// ---------------------------------------------------------------------------

/**
 * `CapacityBlockGroupService` "provides read access to Capacity Block Groups
 * resources": `get`, `getByResourceAffinity`, `list`, `listResources`. No
 * create/update/delete exists — a block group is allocated by the platform, not
 * by a caller.
 */
export interface CapacityBlockGroupService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<CapacityBlockGroup, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /**
   * The lookup a caller wanting `reservationIds` actually needs: `(tenant,
   * region, fabric, platform)` → the group allocated for it.
   *
   * The miss names everything it searched for (measured 2026-09-23), which makes
   * it actionable rather than opaque:
   *
   * ```
   * 5 NOT_FOUND: Capacity Block Group (container id=tenant-e00xt8cvv67054nhsj,
   *   region=eu-north1, resource_affinity=version=<ResourceAffinityVersion.COMPUTE_V1:
   *   'compute_v1'> fabric='fabric-does-not-exist' platform='gpu-h200-sxm') not found
   * ```
   *
   * Contrast with the by-id miss, which names only the id
   * (`… Capacity Block Group (id=…) not found`) — so an affinity lookup that
   * fails tells you *which* `(fabric, platform)` has no reservation, and the id
   * form tells you only that your id was wrong.
   */
  readonly getByResourceAffinity: (req: {
    parentId: string
    region: string
    resourceAffinity: ResourceAffinity
  }) => Effect.Effect.Effect<CapacityBlockGroup, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List every block group for a **tenant** (paginates automatically). */
  readonly list: (
    tenantId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<CapacityBlockGroup>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /**
   * Instance ids currently occupying the group — the occupancy half of
   * "may I still put a node here?". Returns bare ids (the response is a flat
   * `resourceIds` list, not the `items` shape `paginateAll` expects), so it is
   * **not** paginated.
   */
  readonly listResources: (
    id: string,
  ) => Effect.Effect.Effect<ReadonlyArray<string>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// CapacityInterval service — read-only
// ---------------------------------------------------------------------------

/**
 * `CapacityIntervalService` exposes `get` and `list`, both read-only, and
 * `CapacityIntervalSpec` is empty: intervals are created by the platform's
 * capacity allocation, not by callers.
 *
 * The parent of a list is a **Capacity Block Group** (probed: a tenant id there
 * is rejected with `Expected capacityblockgroup type but got tenant`).
 */
export interface CapacityIntervalService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<CapacityInterval, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List every interval of one **Capacity Block Group** (paginates automatically). */
  readonly list: (
    capacityBlockGroupId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<CapacityInterval>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// CapacityAllowance service — read-only here, mutable at the API
// ---------------------------------------------------------------------------
//
// The service *does* expose create/update/delete, and this client deliberately
// exposes none of them: `delete` means "reset the limit to the platform
// default", and `list` can include non-created rows. See
// `modules/resources/capacity/v1/capacity-allowance.schema.ts` for the full
// reasoning and TASKS.md for the parked provider.
//
// Leaving the three mutating RPCs unwrapped keeps the discipline structural: no
// caller can reach a "delete" that does not delete, and `alchemy unsafe nuke`
// has no list-based delete to drive because this is not a provider.

export interface CapacityAllowanceService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<CapacityAllowance, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /**
   * Read the allowance for a `(project, block group)` pair. This is the natural
   * identity of the entity — there is no user-assigned name.
   */
  readonly getByParentAndCapacityBlockGroup: (req: {
    parentId: string
    capacityBlockGroupId: string
  }) => Effect.Effect.Effect<CapacityAllowance, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /**
   * List the allowances of a **project**. The proto notes this includes
   * *"non-created Capacity Allowances as well for clarity, showing the default
   * limit"* — so a row here does not imply this stack (or anyone) created it.
   * Measured on a project whose tenant has no block groups: `items: []`.
   */
  readonly list: (
    projectId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<CapacityAllowance>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List the allowances of one **Capacity Block Group** (across projects). */
  readonly listByCapacityBlockGroup: (
    capacityBlockGroupId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<CapacityAllowance>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface CapacityGrpcServiceShape {
  readonly resourceAdvice: ResourceAdviceService
  readonly capacityBlockGroup: CapacityBlockGroupService
  readonly capacityInterval: CapacityIntervalService
  readonly capacityAllowance: CapacityAllowanceService
}

export class CapacityGrpcService extends Effect.Context.Service<CapacityGrpcService, CapacityGrpcServiceShape>()(
  'CapacityGrpcService',
) {}

// ---------------------------------------------------------------------------
// Pagination request builders
// ---------------------------------------------------------------------------
//
// Exported (like `nvlInstanceGroupListRequest`) so the request shape — in
// particular `pageSize: 100`, probed as accepted — is unit-testable without an
// engine or a network.

/** Build a `ListCapacityBlockGroups` request page (parent = **tenant**). */
export const capacityBlockGroupListRequest = (tenantId: string, pageToken: string) =>
  ListCapacityBlockGroupsRequest.fromPartial({ parentId: tenantId, pageSize: 100, pageToken })

/** Build a `ListCapacityIntervals` request page (parent = **block group**). */
export const capacityIntervalListRequest = (capacityBlockGroupId: string, pageToken: string) =>
  ListCapacityIntervalsRequest.fromPartial({ parentId: capacityBlockGroupId, pageSize: 100, pageToken })

/** Build a `ListCapacityAllowances` request page (parent = **project**). */
export const capacityAllowanceListRequest = (projectId: string, pageToken: string) =>
  ListCapacityAllowancesRequest.fromPartial({ parentId: projectId, pageSize: 100, pageToken })

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const CapacityGrpcServiceLive = Effect.Layer.effect(
  CapacityGrpcService,
  Effect.Effect.gen(function* () {
    const adviceRaw = yield* GrpcUtils.makeGrpcService(NebiusResourceAdviceServiceSchema.ResourceAdviceServiceClient)
    const blockGroupRaw = yield* GrpcUtils.makeGrpcService(
      NebiusCapacityBlockGroupServiceSchema.CapacityBlockGroupServiceClient,
    )
    const intervalRaw = yield* GrpcUtils.makeGrpcService(
      NebiusCapacityIntervalServiceSchema.CapacityIntervalServiceClient,
    )
    const allowanceRaw = yield* GrpcUtils.makeGrpcService(
      NebiusCapacityAllowanceServiceSchema.CapacityAllowanceServiceClient,
    )

    const resourceAdvice: ResourceAdviceService = {
      list: (tenantId: string) =>
        GrpcUtils.paginateAll(
          (req) => adviceRaw.list(req),
          (parentId, pageToken) => ListResourceAdviceRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
          tenantId,
        ),
    }

    const capacityBlockGroup: CapacityBlockGroupService = {
      get: (id: string) => blockGroupRaw.get(GetCapacityBlockGroupRequest.fromPartial({ id })),
      getByResourceAffinity: ({ parentId, region, resourceAffinity }) =>
        blockGroupRaw.getByResourceAffinity(
          GetCapacityBlockGroupByResourceAffinityRequest.fromPartial({ parentId, region, resourceAffinity }),
        ),
      list: (tenantId: string) =>
        GrpcUtils.paginateAll((req) => blockGroupRaw.list(req), capacityBlockGroupListRequest, tenantId),
      listResources: (id: string) =>
        blockGroupRaw
          .listResources(ListCapacityBlockGroupResourcesRequest.fromPartial({ id }))
          .pipe(Effect.Effect.map((response) => response.resourceIds)),
    }

    const capacityInterval: CapacityIntervalService = {
      get: (id: string) => intervalRaw.get(GetCapacityIntervalRequest.fromPartial({ id })),
      list: (capacityBlockGroupId: string) =>
        GrpcUtils.paginateAll((req) => intervalRaw.list(req), capacityIntervalListRequest, capacityBlockGroupId),
    }

    const capacityAllowance: CapacityAllowanceService = {
      get: (id: string) => allowanceRaw.get(GetCapacityAllowanceRequest.fromPartial({ id })),
      getByParentAndCapacityBlockGroup: ({ parentId, capacityBlockGroupId }) =>
        allowanceRaw.getByParentAndCapacityBlockGroup(
          GetCapacityAllowanceByParentAndCapacityBlockGroupRequest.fromPartial({
            parentId,
            capacityBlockGroupId,
          }),
        ),
      list: (projectId: string) =>
        GrpcUtils.paginateAll((req) => allowanceRaw.list(req), capacityAllowanceListRequest, projectId),
      listByCapacityBlockGroup: (capacityBlockGroupId: string) =>
        GrpcUtils.paginateAll(
          (req) => allowanceRaw.listByCapacityBlockGroup(req),
          (_parentId, pageToken) =>
            ListCapacityAllowancesByCapacityBlockGroupRequest.fromPartial({
              capacityBlockGroupId,
              pageSize: 100,
              pageToken,
            }),
          capacityBlockGroupId,
        ),
    }

    return { resourceAdvice, capacityBlockGroup, capacityInterval, capacityAllowance }
  }),
)
