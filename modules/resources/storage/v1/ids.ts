import * as Schema from 'effect/Schema'

// Canonical branded-ID home for `nebius.storage.v1` (AGENTS.md §"Branded IDs").

/** Branded ID for Bucket resources. */
export const BucketId = Schema.String.pipe(Schema.brand('BucketId'))
export type BucketId = typeof BucketId.Type

/** Branded ID for Transfer resources. */
export const TransferId = Schema.String.pipe(Schema.brand('TransferId'))
export type TransferId = typeof TransferId.Type
