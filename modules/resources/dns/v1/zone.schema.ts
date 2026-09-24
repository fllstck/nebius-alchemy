import * as Schema from 'effect/Schema'
import * as VpcIds from '../../vpc/v1/ids.ts'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// Zone Props (user input)
// ---------------------------------------------------------------------------

const VpcZoneScopeSchema = Schema.Struct({
  primaryNetworkId: VpcIds.NetworkId,
})

/**
 * The API ignores a negative-caching TTL below 5 seconds and substitutes its own
 * default — silently. Fail fast rather than accept a value the platform discards.
 */
const negativeTtlValid = Schema.makeFilter(
  (soa: Record<string, unknown>) => {
    const ttl = soa.negativeTtl
    if (ttl === undefined) return undefined
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 5) {
      return {
        path: ['negativeTtl'],
        issue: `negativeTtl must be a whole number of seconds ≥ 5 (lower values are silently ignored by the API), got ${JSON.stringify(ttl)}`,
      }
    }
    return undefined
  },
  { title: 'negative TTL ≥ 5 seconds' },
)

/** Custom SOA (Start of Authority) record settings for the zone. */
const SoaSpecSchema = Schema.Struct({
  /**
   * Negative-caching TTL in seconds for `NXDOMAIN` answers (minimum 5).
   * Lower it when records are frequently deleted and recreated.
   */
  negativeTtl: Schema.optional(Schema.Finite),
}).check(negativeTtlValid)

export const ZonePropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Fully qualified domain name, e.g. "example.com.". Immutable. */
  domainName: Schema.String,
  /** VPC zone scope — zone visible only from the specified network. Required by the API. */
  vpc: VpcZoneScopeSchema,
  /** Custom SOA record settings. Omitted = the platform's SOA defaults. */
  soaSpec: Schema.optional(SoaSpecSchema),
})

export type ZoneProps = typeof ZonePropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateZoneProps = Validation.makeValidateProps(ZonePropsSchema)

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A zone that still holds **user** records cannot be deleted — the API refuses with
 * `9 FAILED_PRECONDITION: Zone … is not empty`.
 *
 * The provider pre-checks it (list the zone's records, ignore the authority records) rather than letting the
 * generic dependent-retry absorb the refusal, because of what the refusal *looks like* on the shared delete
 * path: `9 FAILED_PRECONDITION` is treated there as "a dependent is still tearing down" and re-issued every
 * 20 s for ~4 minutes (`Factory.dependentStillAlive`), so a zone blocked by out-of-band records fails **late,
 * silently, and without naming a single record**. Same shape as `GpuClusterNotEmpty` /
 * `NVLInstanceGroupNotEmpty` / `PricingPolicyHasRunningVms`.
 *
 * Members found here are legitimate blockers rather than a race: records declared in the same stack are
 * dependents of the zone and are deleted **before** it, so a destroy of a well-formed stack sees none. What
 * remains is an out-of-band record (console, script, another stack) or a record whose own delete failed —
 * both need a human, and both are named in the message.
 */
export class ZoneNotEmpty extends Schema.TaggedError<ZoneNotEmpty>()('ZoneNotEmpty', {
  zoneId: Schema.String,
  zoneName: Schema.String,
  records: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Zone Attributes (output)
// ---------------------------------------------------------------------------

export const ZoneAttributesSchema = Schema.Struct({
  id: Ids.ZoneId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  domainName: Schema.String,
  state: Schema.Literal('READY'),
  recordCount: Schema.optional(Schema.String),
})

export type ZoneAttributes = typeof ZoneAttributesSchema.Type
