import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Branded KMS key ID — effectiveKmsKeyId can be either symmetric or asymmetric
// ---------------------------------------------------------------------------

const KmsKeyId = Schema.String.pipe(Schema.brand('KmsKeyId'))

// ---------------------------------------------------------------------------
// Secret Props (user input)
// ---------------------------------------------------------------------------

const PayloadEntrySchema = Schema.Struct({
  key: Schema.String,
  stringValue: Schema.optional(Schema.String),
})

export const SecretPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optional(Schema.String),
  /** Initial payload entries for the first secret version (create only). */
  payloads: Schema.optional(Schema.Array(PayloadEntrySchema)),
})

export type SecretProps = typeof SecretPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateSecretProps = Validation.makeValidateProps(SecretPropsSchema)

// ---------------------------------------------------------------------------
// Secret Attributes (output)
// ---------------------------------------------------------------------------

export const SecretId = Schema.String.pipe(Schema.brand('SecretId'))
export type SecretId = typeof SecretId.Type

export const SecretAttributesSchema = Schema.Struct({
  id: SecretId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  description: Schema.String,
  state: Schema.Union([Schema.Literal('ACTIVE'), Schema.Literal('SCHEDULED_FOR_DELETION')]),
  effectiveKmsKeyId: KmsKeyId,
})

export type SecretAttributes = typeof SecretAttributesSchema.Type
