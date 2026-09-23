import * as Schema from 'effect/Schema'

import * as NebiusCapacityIntervalSchema from '../../../../schemas/nebius/capacity/v1/capacity_interval.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'
import { CapacityIntervalId } from './ids.ts'

// ---------------------------------------------------------------------------
// Capacity Interval attributes
// ---------------------------------------------------------------------------
//
// Read-only, like the block groups they belong to: `CapacityIntervalService`
// exposes `Get` and `List` and nothing else, and **`CapacityIntervalSpec` is an
// empty message** — the whole interval (which resources, how many, for how
// long) is platform-assigned and reported in `status`.
//
// An interval is what actually *schedules* a block group's quota: the group's
// `currentLimit` is the sum of the intervals active at that moment, which is
// why a group can be `STATE_INACTIVE` with a non-zero limit history. Listing
// intervals is therefore how a caller answers "when does this reservation start,
// and how much does it give me?".
//
// Hand-mapped for the same reason as the block group schema: the generic
// `toFriendlyAttributes` JSON overlay drops zero-valued fields, and int64s
// (`quantity`) are typed as strings from the start.

/** The `(fabric, platform)` pair the interval reserves capacity for. */
const ResourceAffinitySchema = Schema.Struct({
  /** Data centre fabric, e.g. `fabric-7`. */
  fabric: Schema.String,
  /** Platform, e.g. `gpu-h200-sxm`. */
  platform: Schema.String,
})

export const CapacityIntervalAttributesSchema = Schema.Struct({
  id: CapacityIntervalId,
  /**
   * The **tenant** the interval was created for ("container" in the proto's
   * vocabulary). Branded via `iam/v2` — the tenant id is that service's entity.
   */
  containerId: Schema.optional(IamV2Ids.TenantId),
  /** Region, e.g. `eu-north1`. */
  region: Schema.String,
  resourceAffinity: Schema.optional(ResourceAffinitySchema),
  /** Derived service name, e.g. `compute`. */
  service: Schema.String,
  /** Reserved quantity, int64 → decimal **string**. `"0"` is preserved. */
  quantity: Schema.String,
  /** Window start. */
  startTime: Schema.optional(Schema.Date),
  /** Window end. */
  endTime: Schema.optional(Schema.Date),
  /** `STATE_SCHEDULED` (future) / `STATE_ACTIVE` / `STATE_EXPIRED` (past). */
  state: Schema.optional(Schema.String),
  /** The API reports an in-flight change. */
  reconciling: Schema.Boolean,
})

export type CapacityIntervalAttributes = typeof CapacityIntervalAttributesSchema.Type

/** Zero enum member (`STATE_UNSPECIFIED`, "shouldn't happen") → `undefined`. */
const enumName = (value: number | undefined, toName: (v: number) => string): string | undefined =>
  value === undefined || value === 0 ? undefined : toName(value)

/** Friendly attributes for one Capacity Interval. */
export const toFriendlyAttributes = (
  raw: NebiusCapacityIntervalSchema.CapacityInterval,
): CapacityIntervalAttributes => {
  const status = raw.status
  const affinity = status?.resourceAffinity?.computeV1
  // `containerId` is a tenant id, and `IamV2Ids.TenantId` carries no refinement,
  // but the empty string is still not an id — omit rather than brand a `''`.
  const containerId = status?.containerId

  return {
    id: CapacityIntervalId.make(raw.metadata?.id ?? ''),
    containerId: containerId ? IamV2Ids.TenantId.make(containerId) : undefined,
    region: status?.region ?? '',
    resourceAffinity: affinity ? { fabric: affinity.fabric, platform: affinity.platform } : undefined,
    service: status?.service ?? '',
    quantity: status?.quantity?.toString() ?? '0',
    startTime: status?.startTime,
    endTime: status?.endTime,
    state: enumName(status?.state, NebiusCapacityIntervalSchema.capacityIntervalStatus_StateToJSON),
    reconciling: status?.reconciling ?? false,
  }
}
