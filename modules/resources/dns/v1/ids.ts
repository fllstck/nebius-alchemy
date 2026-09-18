import * as Schema from 'effect/Schema'

// Canonical branded-ID home for `nebius.dns.v1` (AGENTS.md §"Branded IDs").

/** Branded ID for DNS Zone resources. */
export const ZoneId = Schema.String.pipe(Schema.brand('ZoneId'))
export type ZoneId = typeof ZoneId.Type

/** Branded ID for DNS Record resources. */
export const RecordId = Schema.String.pipe(Schema.brand('RecordId'))
export type RecordId = typeof RecordId.Type
