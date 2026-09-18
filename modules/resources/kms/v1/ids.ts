import * as Schema from 'effect/Schema'

// Canonical branded-ID home for `nebius.kms.v1` (AGENTS.md §"Branded IDs").

/** Branded ID for SymmetricKey resources. */
export const SymmetricKeyId = Schema.String.pipe(Schema.brand('SymmetricKeyId'))
export type SymmetricKeyId = typeof SymmetricKeyId.Type

/** Branded ID for AsymmetricKey resources. */
export const AsymmetricKeyId = Schema.String.pipe(Schema.brand('AsymmetricKeyId'))
export type AsymmetricKeyId = typeof AsymmetricKeyId.Type

/**
 * Branded ID of a **KMS key of either kind**. `effectiveKmsKeyId` on a
 * MysteryBox secret is reported as symmetric *or* asymmetric, so it is a
 * nominal brand of its own rather than one of the two key brands.
 */
export const KmsKeyId = Schema.String.pipe(Schema.brand('KmsKeyId'))
export type KmsKeyId = typeof KmsKeyId.Type
