import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// SymmetricKey Props (user input)
// ---------------------------------------------------------------------------

export const SymmetricAlgorithmSchema = Schema.Union([
  Schema.Literal('AES_256'),
])

export const SymmetricKeyPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optional(Schema.String),
  /** Encryption algorithm. Immutable after creation. Default: AES_256. */
  algorithm: Schema.optional(SymmetricAlgorithmSchema),
})

export type SymmetricKeyProps = typeof SymmetricKeyPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateSymmetricKeyProps = Validation.makeValidateProps(SymmetricKeyPropsSchema)

// ---------------------------------------------------------------------------
// SymmetricKey Attributes (output)
// ---------------------------------------------------------------------------

export const SymmetricKeyId = Schema.String.pipe(Schema.brand('SymmetricKeyId'))
export type SymmetricKeyId = typeof SymmetricKeyId.Type

export const SymmetricKeyAttributesSchema = Schema.Struct({
  id: SymmetricKeyId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  description: Schema.String,
  algorithm: SymmetricAlgorithmSchema,
  state: Schema.String,
})

export type SymmetricKeyAttributes = typeof SymmetricKeyAttributesSchema.Type
