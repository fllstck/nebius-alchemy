import * as Schema from 'effect/Schema'

import * as NebiusResourceAdviceSchema from '../../../../schemas/nebius/capacity/v1/resource_advice.ts'

// ---------------------------------------------------------------------------
// ResourceAdvice attributes
// ---------------------------------------------------------------------------
//
// NOT a resource: the capacity advisor returns *virtual* rows describing what a
// tenant can get for a (region, fabric, platform, preset). Field names follow the
// generated schema verbatim (AGENTS.md §"Naming"), and the enum-valued fields
// carry the generated `…ToJSON` names (`DATA_STATE_FRESH`, not a hand-written
// string).
//
// This maps EXPLICITLY rather than going through `ResourceUtils.toFriendlyAttributes`,
// and that is deliberate: the generic helper overlays the message's JSON form,
// which **omits zero-valued fields** — so `available: 0` (the single most
// important value here: "nothing right now") and the zero enum members would
// silently disappear, and advisory rows have no meaningful metadata to spread in
// the first place.

/** Availability of one capacity class (reserved / on-demand / preemptible). */
const AvailabilitySchema = Schema.Struct({
  /**
   * Freshness of the measurement — `DATA_STATE_FRESH` / `DATA_STATE_STALE` /
   * `DATA_STATE_UNKNOWN` (`DATA_STATE_UNSPECIFIED` is documented as
   * "shouldn't ever happen" and normalizes to an omitted field).
   */
  dataState: Schema.optional(Schema.String),
  /** Units that can be allocated right now (already clipped by quota). */
  available: Schema.Finite,
  /** The tenant's quota limit for this resource type. */
  limit: Schema.Finite,
  /**
   * Categorical indicator — `AVAILABILITY_LEVEL_HIGH` / `_MEDIUM` / `_LOW` /
   * `_LIMIT_REACHED` / `_UNKNOWN`.
   */
  availabilityLevel: Schema.optional(Schema.String),
  /** When the infrastructure reported this measurement. */
  effectiveAt: Schema.optional(Schema.Date),
})

export const ResourceAdviceAttributesSchema = Schema.Struct({
  /** Geographical region identifier, e.g. `eu-north1`. */
  region: Schema.String,
  /**
   * **Data center fabric** — the value `Nebius.compute.GpuCluster` wants for its
   * required `infinibandFabric` prop. (The proto calls it "data center fabric or
   * cluster identifier"; `GpuClusterSpec` spells the same thing
   * `infiniband_fabric`.) Identity is verified by the live probe in
   * `tests/resources/actions/capacity.test.ts`.
   */
  fabric: Schema.String,
  /** The machine this advice applies to. */
  computeInstance: Schema.optional(
    Schema.Struct({
      /** Platform, e.g. `gpu-h200-sxm`. */
      platform: Schema.String,
      preset: Schema.optional(
        Schema.Struct({
          /** Preset name, e.g. `8gpu-128vcpu-1600gb`. */
          name: Schema.String,
          resources: Schema.optional(
            Schema.Struct({
              vcpuCount: Schema.Finite,
              memoryGibibytes: Schema.Finite,
              gpuCount: Schema.Finite,
            }),
          ),
        }),
      ),
      /** GPU memory per machine (GiB); 0 for CPU-only platforms. */
      gpuMemoryGigabytes: Schema.Finite,
    }),
  ),
  /** Capacity for reserved/guaranteed resources through Capacity Blocks. */
  reserved: Schema.optional(AvailabilitySchema),
  /** Capacity for regular on-demand resources. */
  onDemand: Schema.optional(AvailabilitySchema),
  /** Capacity for preemptible/spot resources. */
  preemptible: Schema.optional(AvailabilitySchema),
})

export type ResourceAdviceAttributes = typeof ResourceAdviceAttributesSchema.Type

/** Normalize a zero enum member (omitted by the generated `toJSON`) to `undefined`. */
const enumName = (value: number | undefined, toName: (v: number) => string): string | undefined =>
  value === undefined || value === 0 ? undefined : toName(value)

const availability = (
  raw: NebiusResourceAdviceSchema.ResourceAdviceStatus_Availability | undefined,
): ResourceAdviceAttributes['onDemand'] => {
  if (!raw) return undefined
  return {
    dataState: enumName(
      raw.dataState,
      NebiusResourceAdviceSchema.resourceAdviceStatus_Availability_DataStateToJSON,
    ),
    available: raw.available,
    limit: raw.limit,
    availabilityLevel: enumName(
      raw.availabilityLevel,
      NebiusResourceAdviceSchema.resourceAdviceStatus_Availability_AvailabilityLevelToJSON,
    ),
    effectiveAt: raw.effectiveAt,
  }
}

/**
 * Friendly attributes for one advice row.
 *
 * Keeps the zeroes: `available: 0` means "no capacity right now", which is the
 * answer a caller is usually looking for — do not route this through
 * `toFriendlyAttributes`, whose JSON overlay would drop it.
 */
export const toFriendlyAttributes = (
  raw: NebiusResourceAdviceSchema.ResourceAdvice,
): ResourceAdviceAttributes => ({
  region: raw.spec?.region ?? '',
  fabric: raw.spec?.fabric ?? '',
  computeInstance: raw.spec?.computeInstance
    ? {
        platform: raw.spec.computeInstance.platform,
        preset: raw.spec.computeInstance.preset
          ? {
              name: raw.spec.computeInstance.preset.name,
              resources: raw.spec.computeInstance.preset.resources
                ? {
                    vcpuCount: raw.spec.computeInstance.preset.resources.vcpuCount,
                    memoryGibibytes: raw.spec.computeInstance.preset.resources.memoryGibibytes,
                    gpuCount: raw.spec.computeInstance.preset.resources.gpuCount,
                  }
                : undefined,
            }
          : undefined,
        gpuMemoryGigabytes: raw.spec.computeInstance.gpuMemoryGigabytes,
      }
    : undefined,
  reserved: availability(raw.status?.reserved),
  onDemand: availability(raw.status?.onDemand),
  preemptible: availability(raw.status?.preemptible),
})
