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
