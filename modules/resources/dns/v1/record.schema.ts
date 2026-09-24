import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// Record Props (user input)
// ---------------------------------------------------------------------------

/**
 * `ttl` — measured live 2026-09-24 (`spikes/dns-ttl-bounds-probe.ts`), because the earlier reading in the
 * validation audit was wrong in both directions. One zone, one record per value, **each read back** so a
 * substituted value is visible rather than inferred:
 *
 * | requested `ttl` (s) | API | `spec.ttl` read back |
 * | `-1`, `0`, `0.5` | accepted | **600** — *silently substituted*, no error |
 * | `1`, `5`, `600`, `604800` (7d), `2592000` (30d), `31536000` (365d) | accepted | the value sent |
 * | `2147483647` (`INT32_MAX`) | accepted | the value sent |
 * | `2147483648`, `4294967295` | **rejected** — `3 INVALID_ARGUMENT: Invalid Record TTL` | — |
 *
 * Two consequences, and the first is why this is a filter rather than a doc note:
 *
 *  1. **A pinned `ttl ≤ 0` (or fractional) is an update loop.** The wire field is an int64, so the API takes
 *     the value, replaces it with its own default 600, and echoes 600 — while `reconcile` compares the live
 *     echo against the pinned value (`news.ttl !== undefined &&` — the guard that exists because an *omitted*
 *     `ttl` encodes as 0). A pinned `0` therefore plans an update on every reconcile that can never converge.
 *  2. **`> INT32_MAX` is an apply-time failure whose message names no bound.** Fail fast with the real range.
 *
 * The audit's "`30d` and `365d` are rejected with HTTP 400" is **not reproducible** through the API: those
 * exact values were accepted and echoed. Whatever the earlier probe hit, it was not this bound (a
 * `d`-suffixed *string* is the obvious candidate — this service parses `ttl` as a number).
 *
 * Integrality is required for the same measured reason as the low bound: `0.5` is accepted and comes back as
 * 600, so a fractional second is a silent substitution too, never a truncation.
 */
const ttlValid = Schema.makeFilter(
  (ttl: number) =>
    Number.isInteger(ttl) && ttl >= 1 && ttl <= 2147483647
      ? undefined
      : `ttl must be a whole number of seconds between 1 and 2147483647, got ${JSON.stringify(ttl)}. ` +
        `Values ≤ 0 (and fractional ones) are accepted by the API but silently replaced with its default 600 — ` +
        `which can never converge, since the provider compares the live echo against the pinned value — and a ` +
        `value above 2147483647 is refused with a bare "Invalid Record TTL". Omit \`ttl\` for the default.`,
  { title: 'record TTL in seconds (1 … INT32_MAX)' },
)

const RecordTypeSchema = Schema.Union([
  Schema.Literal('A'),
  Schema.Literal('AAAA'),
  Schema.Literal('PTR'),
  Schema.Literal('CNAME'),
  Schema.Literal('MX'),
  Schema.Literal('TXT'),
  Schema.Literal('SRV'),
  Schema.Literal('NS'),
  Schema.Literal('CAA'),
])

export const RecordPropsSchema = Schema.Struct({
  /** Parent zone ID. */
  parentId: Ids.ZoneId,
  /** Zone-relative name, e.g. "www" or "@" for apex. */
  relativeName: Schema.String,
  /** Record type. */
  type: RecordTypeSchema,
  /**
   * Record TTL in seconds, `1 … 2147483647`. Default: 600 (omit the prop).
   *
   * A pinned value ≤ 0 or a fractional one is rejected at plan time: the API accepts it and silently
   * substitutes 600, and this provider compares the live echo against the pinned value, so it would write an
   * update on every reconcile that can never converge. See {@link ttlValid} for the measurement table.
   */
  ttl: Schema.optional(Schema.Finite.check(ttlValid)),
  /** Record data in presentation (zonefile) format. */
  data: Schema.String,
  /** Protect this record from accidental deletion. */
  deletionProtection: Schema.optional(Schema.Boolean),
})

export type RecordProps = typeof RecordPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateRecordProps = Validation.makeValidateProps(RecordPropsSchema)

// ---------------------------------------------------------------------------
// Record Attributes (output)
// ---------------------------------------------------------------------------

export const RecordAttributesSchema = Schema.Struct({
  id: Ids.RecordId,
  parentId: Ids.ZoneId,
  name: Schema.String,
  relativeName: Schema.optional(Schema.String),
  type: RecordTypeSchema,
  ttl: Schema.optional(Schema.String),
  data: Schema.String,
  effectiveFqdn: Schema.optional(Schema.String),
})

export type RecordAttributes = typeof RecordAttributesSchema.Type
