import * as Schema from 'effect/Schema'

// Canonical branded-ID home for `nebius.mysterybox.v1` (AGENTS.md §"Branded IDs").

/** Branded ID for Secret resources. */
export const SecretId = Schema.String.pipe(Schema.brand('SecretId'))
export type SecretId = typeof SecretId.Type

/** Branded ID for SecretVersion resources. */
export const SecretVersionId = Schema.String.pipe(Schema.brand('SecretVersionId'))
export type SecretVersionId = typeof SecretVersionId.Type
