import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as CapacityGrpc from '../../../api-client/capacity.ts'
import { resolveTenantId } from '../../shared/tenant.ts'
import * as ResourceAdviceSchema from './resource-advice.schema.ts'

// ── Capacity advice (read-only) ────────────────────────────────────────────
//
// The capacity advisor answers "what can I actually get, and where?" — per
// tenant, per (region, fabric, platform, preset), with availability split by
// capacity class. It is the only in-API source of **fabric** identifiers, which
// is what `Nebius.compute.GpuCluster`'s required `infinibandFabric` prop needs
// (see TASKS.md §"fabric discovery").
//
// Read-only by construction: the service exposes `list` and nothing else, so
// this action can never mutate anything. It deliberately does NOT cover Capacity
// *Block* ids (`reservationPolicy.reservationIds`) — those live in the separate
// capacity-blocks family.

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
