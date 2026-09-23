import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Option from 'effect/Option'
import * as CapacityGrpc from '../../../api-client/capacity.ts'
import { resolveTenantId } from '../../shared/tenant.ts'
import * as ResourceAdviceSchema from './resource-advice.schema.ts'
import * as CapacityBlockGroupSchema from './capacity-block-group.schema.ts'
import * as CapacityIntervalSchema from './capacity-interval.schema.ts'
import * as CapacityAllowanceSchema from './capacity-allowance.schema.ts'

// ── Capacity discovery (read-only) ─────────────────────────────────────────
//
// Two families live behind two hosts, and both are **read-only**:
//
//   capacity-advisor…  ResourceAdviceService       — what can I get, where
//   capacity-blocks…   CapacityBlockGroupService   — the reservations I hold
//                      CapacityIntervalService    — when they run, how much
//                      CapacityAllowanceService   — the per-project limit
//
// Nothing here mutates. That is the API's shape, not a simplification:
// `CapacityBlockGroupSpec` and `CapacityIntervalSpec` are *empty messages*, and
// their services expose no create/update/delete. The one mutable member,
// `CapacityAllowance`, is exposed **read-only on purpose** — its `delete` resets
// a limit to the platform default rather than removing anything, and its rows can
// exist before anyone creates them. See `capacity-allowance.schema.ts`.
//
// ## What this unblocks
//
// `resourceAdvice` answers "is there capacity, and on which fabric" — that is
// what `GpuCluster.infinibandFabric` needs. The block-group actions answer the
// **other** placement question: which *reservation* to spend. Their ids are what
// `reservationPolicy.reservationIds` takes, so these actions are how a caller
// obtains a branded `CapacityBlockGroupId` instead of hand-writing one.

export interface ListResourceAdviceFilter {
  /** Exact region match, e.g. `eu-north1`. */
  region?: string
  /** Exact platform match, e.g. `gpu-h200-sxm`. */
  platform?: string
  /** Exact preset-name match, e.g. `8gpu-128vcpu-1600gb`. */
  preset?: string
}

/**
 * Client-side narrowing. The API's `List` takes no filter field (only
 * `parentId`/paging), so the tenant's whole advice set is fetched and narrowed
 * here. Exported pure so the filter semantics are unit-testable without an
 * engine — an `Alchemy.Action` resolves through the stack, so it cannot be
 * called standalone (see the test file).
 */
export const filterResourceAdvice = (
  rows: ReadonlyArray<ResourceAdviceSchema.ResourceAdviceAttributes>,
  filter: ListResourceAdviceFilter,
): ReadonlyArray<ResourceAdviceSchema.ResourceAdviceAttributes> =>
  rows
    .filter((advice) => filter.region === undefined || advice.region === filter.region)
    .filter((advice) => filter.platform === undefined || advice.computeInstance?.platform === filter.platform)
    .filter((advice) => filter.preset === undefined || advice.computeInstance?.preset?.name === filter.preset)

/**
 * List capacity advice for the tenant, optionally narrowed client-side.
 *
 * Unfiltered, the result is regions × fabrics × platforms × presets, so filter
 * by `region` (and usually `platform`) unless you want the full matrix. An
 * unmatched filter returns `[]` rather than failing — this is a listing, not a
 * lookup. The available fabrics are one `new Set(rows.map((r) => r.fabric))`.
 */
export const ListResourceAdvice = Alchemy.Action(
  'Nebius.capacity.actions.ListResourceAdvice',
  Effect.gen(function* () {
    const capacity = yield* CapacityGrpc.CapacityGrpcService
    const tenantId = yield* resolveTenantId()
    // No default value on `filter`: a defaulted parameter makes `In` infer as
    // `T | undefined`, the call signature's mapped type then collapses to `{}`,
    // and callers lose BOTH the input type and the `Out` type (no `.map`, no
    // `.length`) even though the action works at runtime. Pass `({})` for
    // "everything" instead.
    return (filter: ListResourceAdviceFilter) =>
      Effect.gen(function* () {
        const rows = yield* capacity.resourceAdvice.list(tenantId)
        return filterResourceAdvice(
          rows.map((raw) => ResourceAdviceSchema.toFriendlyAttributes(raw)),
          filter,
        )
      })
  }),
)

// ── Capacity block groups (the `reservationIds` namespace) ─────────────────

export interface ListCapacityBlockGroupsFilter {
  /** Exact region match, e.g. `eu-north1`. */
  region?: string
  /** Exact fabric match, e.g. `fabric-7`. */
  fabric?: string
  /** Exact platform match, e.g. `gpu-h200-sxm`. */
  platform?: string
}

/**
 * Client-side narrowing, for the same reason as `filterResourceAdvice`: the
 * block-group `List` takes only `parentId`/paging. A group whose
 * `resourceAffinity` the API left empty matches no fabric/platform filter but is
 * still returned by an unfiltered call.
 */
export const filterCapacityBlockGroups = (
  rows: ReadonlyArray<CapacityBlockGroupSchema.CapacityBlockGroupAttributes>,
  filter: ListCapacityBlockGroupsFilter,
): ReadonlyArray<CapacityBlockGroupSchema.CapacityBlockGroupAttributes> =>
  rows
    .filter((group) => filter.region === undefined || group.region === filter.region)
    .filter((group) => filter.fabric === undefined || group.resourceAffinity?.fabric === filter.fabric)
    .filter((group) => filter.platform === undefined || group.resourceAffinity?.platform === filter.platform)

/**
 * List the Capacity Block Groups the **tenant** holds.
 *
 * These ids are the values `reservationPolicy.reservationIds` accepts, in
 * priority order. Measured 2026-09-23: this tenant has none, so the live answer
 * is `[]` — an empty result is a valid, meaningful answer here and not an error.
 */
export const ListCapacityBlockGroups = Alchemy.Action(
  'Nebius.capacity.actions.ListCapacityBlockGroups',
  Effect.gen(function* () {
    const capacity = yield* CapacityGrpc.CapacityGrpcService
    const tenantId = yield* resolveTenantId()
    return (filter: ListCapacityBlockGroupsFilter) =>
      Effect.gen(function* () {
        const rows = yield* capacity.capacityBlockGroup.list(tenantId)
        return filterCapacityBlockGroups(
          rows.map((raw) => CapacityBlockGroupSchema.toFriendlyAttributes(raw)),
          filter,
        )
      })
  }),
)

/**
 * Read one Capacity Block Group by id.
 *
 * A missing id is a real failure, not an empty result — the API answers
 * `5 NOT_FOUND: Capacity Block Group (id=…) not found` (probed).
 *
 * NOTE: an action's input is required to be an **object** (`ActionRunner` is
 * typed `input extends object | undefined`), so a lone id cannot be passed
 * positionally. That is the same family of constraint as the defaulted-parameter
 * footgun documented on `ListResourceAdvice`: the runner's input type is
 * structural, and a scalar collapses it.
 */
export const GetCapacityBlockGroup = Alchemy.Action(
  'Nebius.capacity.actions.GetCapacityBlockGroup',
  Effect.gen(function* () {
    const capacity = yield* CapacityGrpc.CapacityGrpcService
    return (input: { id: string }) =>
      Effect.gen(function* () {
        const raw = yield* capacity.capacityBlockGroup.get(input.id)
        return CapacityBlockGroupSchema.toFriendlyAttributes(raw)
      })
  }),
)

export interface CapacityBlockGroupAffinityLookup {
  /** Region, e.g. `eu-north1`. */
  region: string
  /** Fabric, e.g. `fabric-7` — the value `resourceAdvice` reports. */
  fabric: string
  /** Platform, e.g. `gpu-h200-sxm`. */
  platform: string
}

/**
 * Resolve the block group allocated for a `(region, fabric, platform)` triple —
 * the lookup that turns an advice row into a `reservationIds` entry.
 *
 * Server-side (`GetByResourceAffinity`), unlike the two filters above, because
 * the answer is a single entity keyed by that triple. Scoped to the **tenant**.
 */
export const GetCapacityBlockGroupByResourceAffinity = Alchemy.Action(
  'Nebius.capacity.actions.GetCapacityBlockGroupByResourceAffinity',
  Effect.gen(function* () {
    const capacity = yield* CapacityGrpc.CapacityGrpcService
    const tenantId = yield* resolveTenantId()
    return (lookup: CapacityBlockGroupAffinityLookup) =>
      Effect.gen(function* () {
        const raw = yield* capacity.capacityBlockGroup.getByResourceAffinity({
          parentId: tenantId,
          region: lookup.region,
          resourceAffinity: { computeV1: { fabric: lookup.fabric, platform: lookup.platform } },
        })
        return CapacityBlockGroupSchema.toFriendlyAttributes(raw)
      })
  }),
)

// ── Capacity intervals (when a reservation runs, and how much) ─────────────

/**
 * List the intervals of one Capacity Block Group.
 *
 * The group's `currentLimit` is the sum of the intervals active at that moment,
 * so this is how a caller answers "when does this reservation start, and how
 * much does it give me?". Parent is a **block group**, not a tenant or project —
 * passing a tenant is rejected by the API with
 * `parent_id: Value error, Expected capacityblockgroup type but got tenant`.
 */
export const ListCapacityIntervals = Alchemy.Action(
  'Nebius.capacity.actions.ListCapacityIntervals',
  Effect.gen(function* () {
    const capacity = yield* CapacityGrpc.CapacityGrpcService
    return (input: { capacityBlockGroupId: string }) =>
      Effect.gen(function* () {
        const rows = yield* capacity.capacityInterval.list(input.capacityBlockGroupId)
        return rows.map((raw) => CapacityIntervalSchema.toFriendlyAttributes(raw))
      })
  }),
)

// ── Capacity allowances (the per-project limit on a block group) ────────────

export interface ListCapacityAllowancesFilter {
  /**
   * Project to read. Defaults to `NEBIUS_PROJECT_ID` — the same fallback the
   * quota provider uses — because an allowance is per project and a stack almost
   * always means its own.
   */
  projectId?: string
  /** Narrow to one Capacity Block Group, client-side. */
  capacityBlockGroupId?: string
}

/**
 * List the Capacity Allowances of a project.
 *
 * ⚠️ **A row here does not mean someone created it.** The proto is explicit that
 * `List` includes *"non-created Capacity Allowances as well for clarity, showing
 * the default limit"*. So compare against the **default** rather than treating
 * presence as ownership. `limit: undefined` means *unlimited*, not zero.
 */
export const ListCapacityAllowances = Alchemy.Action(
  'Nebius.capacity.actions.ListCapacityAllowances',
  Effect.gen(function* () {
    const capacity = yield* CapacityGrpc.CapacityGrpcService
    const configuredProjectId = yield* Config.option(Config.String('NEBIUS_PROJECT_ID'))
    return (filter: ListCapacityAllowancesFilter) =>
      Effect.gen(function* () {
        const projectId = filter.projectId ?? Option.getOrUndefined(configuredProjectId)
        if (!projectId) {
          // Same actionable shape as `resolveTenantId`: name the variable and
          // say how to supply it, rather than failing on a bare Config error.
          return yield* Effect.die(
            new Error(
              'Nebius project ID is required to list capacity allowances but NEBIUS_PROJECT_ID is not set. ' +
                'Pass `{ projectId }` or export NEBIUS_PROJECT_ID.',
            ),
          )
        }
        const rows = yield* capacity.capacityAllowance.list(projectId)
        const mapped = rows.map((raw) => CapacityAllowanceSchema.toFriendlyAttributes(raw))
        return filter.capacityBlockGroupId === undefined
          ? mapped
          : mapped.filter((row) => row.capacityBlockGroupId === filter.capacityBlockGroupId)
      })
  }),
)
