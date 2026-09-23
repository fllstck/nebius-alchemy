import * as Schema from 'effect/Schema'

import * as NebiusCapacityBlockGroupSchema from '../../../../schemas/nebius/capacity/v1/capacity_block_group.ts'
import { CapacityBlockGroupId } from './ids.ts'

// ---------------------------------------------------------------------------
// Capacity Block Group attributes
// ---------------------------------------------------------------------------
//
// NOT a resource this provider manages — the capacity family is **read-only**
// apart from `CapacityAllowance`, and `CapacityBlockGroupSpec` is an *empty*
// message (`{}`): every field a block group has is platform-assigned and lives
// in `status`. The service confirms it in words — `CapacityBlockGroupService`
// "provides read access to Capacity Block Groups resources" — exposing
// `Get`, `GetByResourceAffinity`, `List` and `ListResources`, and no
// create/update/delete at all.
//
// So this is the **discovery** half, modeled exactly like the resource-advice
// rows next door: a hand-written mapper over a read-only RPC.
//
// Hand-written rather than `ResourceUtils.toFriendlyAttributes`, for the reason
// `resource-advice.schema.ts` documents: the generic helper overlays the
// message's JSON rendering, which **omits zero-valued fields**, so
// `usage: 0`/"nothing is used" — a meaningful answer — would silently become
// `undefined`. It also renders every int64 as a decimal string; the mapper below
// types them that way from the start instead of leaving a `Schema.Finite` that
// lies (AGENTS.md §"Resource Lifecycle Details").

/**
 * The `(fabric, platform)` pair a block group is allocated for. The proto has a
 * `oneof`-shaped envelope (`resourceAffinity.computeV1`) so a second service
 * family can be added without breaking callers; `computeV1` is the only variant
 * today, so it is flattened here.
 *
 * Both values are the same namespace the resource advisor reports:
 * `fabric` is what `GpuClusterSpec.infinibandFabric` wants, `platform` is what
 * `InstanceSpec.platform` wants.
 */
const ResourceAffinitySchema = Schema.Struct({
  /** Data centre fabric, e.g. `fabric-7`. */
  fabric: Schema.String,
  /** Platform, e.g. `gpu-h200-sxm`. */
  platform: Schema.String,
})

/** The current (or last, or next) run of back-to-back intervals. */
const CurrentContinuousIntervalSchema = Schema.Struct({
  startTime: Schema.optional(Schema.Date),
  endTime: Schema.optional(Schema.Date),
  /**
   * Quota quantity in effect across that run. int64 on the wire → decimal
   * **string** here, like every other int64 attribute.
   */
  quantity: Schema.String,
  /** `STATE_SCHEDULED` / `STATE_ACTIVE` / `STATE_EXPIRED`. */
  state: Schema.optional(Schema.String),
})

export const CapacityBlockGroupAttributesSchema = Schema.Struct({
  /** The block group id — the value `reservationPolicy.reservationIds` takes. */
  id: CapacityBlockGroupId,
  /** Region of the allocation, e.g. `eu-north1`. */
  region: Schema.String,
  /** Which `(fabric, platform)` the group is for. Omitted when the API leaves it empty. */
  resourceAffinity: Schema.optional(ResourceAffinitySchema),
  /**
   * The service the group is allocated for, derived from the affinity variant
   * (`compute_v1` → `"compute"`, `tokenfactory_v1` → `"tokenfactory"`).
   */
  service: Schema.String,
  /**
   * `STATE_ALLOCATING` / `STATE_ACTIVE` / `STATE_SHUTTING` / `STATE_INACTIVE`
   * (`STATE_UNSPECIFIED` normalizes to omitted).
   */
  state: Schema.optional(Schema.String),
  /** `USAGE_STATE_USED` / `USAGE_STATE_NOT_USED` / `USAGE_STATE_UNKNOWN`. */
  usageState: Schema.optional(Schema.String),
  /**
   * Current quota limit, int64 → decimal **string**. Kept even when `"0"`:
   * a zero limit is the answer to "may I use this block group?", which is why
   * this mapper does not go through `toFriendlyAttributes`.
   */
  currentLimit: Schema.String,
  /** Current usage, int64 → decimal **string**. `"0"` survives for the same reason. */
  usage: Schema.String,
  /** Usage as a percentage — already a string on the wire. */
  usagePercentage: Schema.String,
  /** When the limit next changes (a scheduled interval boundary). */
  nextChangeAt: Schema.optional(Schema.Date),
  /** The limit that change brings, int64 → decimal **string**. */
  nextChangeTo: Schema.optional(Schema.String),
  /** Concatenation of the non-zero intervals that overlap or abut. */
  currentContinuousInterval: Schema.optional(CurrentContinuousIntervalSchema),
  /** The API reports an in-flight change. */
  reconciling: Schema.Boolean,
})

export type CapacityBlockGroupAttributes = typeof CapacityBlockGroupAttributesSchema.Type

/**
 * Normalize the zero enum member (`STATE_UNSPECIFIED`, documented as "shouldn't
 * happen") to `undefined` so callers never branch on a fake name.
 */
const enumName = (value: number | undefined, toName: (v: number) => string): string | undefined =>
  value === undefined || value === 0 ? undefined : toName(value)

const longToString = (value: { toString(): string } | undefined): string => value?.toString() ?? '0'

/** Friendly attributes for one Capacity Block Group. */
export const toFriendlyAttributes = (
  raw: NebiusCapacityBlockGroupSchema.CapacityBlockGroup,
): CapacityBlockGroupAttributes => {
  const status = raw.status
  const affinity = status?.resourceAffinity?.computeV1
  const interval = status?.currentContinuousInterval

  return {
    // `metadata.id` is branded at this boundary: the wire is a plain string, the
    // attribute is an id (`Schema.brand` validates in `.make`).
    id: CapacityBlockGroupId.make(raw.metadata?.id ?? ''),
    region: status?.region ?? '',
    resourceAffinity: affinity ? { fabric: affinity.fabric, platform: affinity.platform } : undefined,
    service: status?.service ?? '',
    state: enumName(status?.state, NebiusCapacityBlockGroupSchema.capacityBlockGroupStatus_StateToJSON),
    usageState: enumName(
      status?.usageState,
      NebiusCapacityBlockGroupSchema.capacityBlockGroupStatus_UsageStateToJSON,
    ),
    currentLimit: longToString(status?.currentLimit),
    usage: longToString(status?.usage),
    usagePercentage: status?.usagePercentage ?? '',
    nextChangeAt: status?.nextChangeAt,
    nextChangeTo: status?.nextChangeTo === undefined ? undefined : longToString(status.nextChangeTo),
    currentContinuousInterval: interval
      ? {
          startTime: interval.startTime,
          endTime: interval.endTime,
          quantity: longToString(interval.quantity),
          state: enumName(
            interval.state,
            NebiusCapacityBlockGroupSchema.currentContinuousInterval_StateToJSON,
          ),
        }
      : undefined,
    reconciling: status?.reconciling ?? false,
  }
}
