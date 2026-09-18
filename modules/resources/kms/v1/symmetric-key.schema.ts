import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// SymmetricKey Props (user input)
// ---------------------------------------------------------------------------

export const SymmetricAlgorithmSchema = Schema.Union([
  Schema.Literal('AES_256'),
])

/**
 * Rotation-period bounds the platform enforces (`rotation_period`): 1 day is
 * the floor it silently clamps to, 10 years the ceiling. Catch both at plan
 * time instead of letting the API reject or rewrite the value.
 */
const isValidRotationPeriodSeconds = Schema.makeFilter(
  (n: number) =>
    Number.isInteger(n) && n >= 86_400 && n <= 315_360_000
      ? undefined
      : `rotationPeriodSeconds must be a whole number of seconds between 86400 (1 day) and 315360000 (10 years), got ${n}`,
  { title: 'key rotation period' },
)

export const SymmetricKeyPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optional(Schema.String),
  /** Encryption algorithm. Immutable after creation. Default: AES_256. */
  algorithm: Schema.optional(SymmetricAlgorithmSchema),
  /**
   * Automatic key rotation period in seconds (1 day … 10 years). Omitted = the
   * platform default applies. Rotation is only *scheduled* by this field; the
   * key stays usable while it rotates.
   */
  rotationPeriodSeconds: Schema.optional(Schema.Finite.check(isValidRotationPeriodSeconds)),
})

export type SymmetricKeyProps = typeof SymmetricKeyPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateSymmetricKeyProps = Validation.makeValidateProps(SymmetricKeyPropsSchema)

// ---------------------------------------------------------------------------
// SymmetricKey Attributes (output)
// ---------------------------------------------------------------------------

export const SymmetricKeyAttributesSchema = Schema.Struct({
  id: Ids.SymmetricKeyId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  description: Schema.String,
  algorithm: SymmetricAlgorithmSchema,
  state: Schema.String,
})

export type SymmetricKeyAttributes = typeof SymmetricKeyAttributesSchema.Type
