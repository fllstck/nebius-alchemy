import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'
import * as KmsIds from '../../kms/v1/ids.ts'

// ---------------------------------------------------------------------------
// Secret Props (user input)
// ---------------------------------------------------------------------------

const PayloadEntrySchema = Schema.Struct({
  key: Schema.String,
  stringValue: Schema.optional(Schema.String),
})

export const SecretPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
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

export const SecretAttributesSchema = Schema.Struct({
  id: Ids.SecretId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  description: Schema.String,
  state: Schema.Union([Schema.Literal('ACTIVE'), Schema.Literal('SCHEDULED_FOR_DELETION')]),
  effectiveKmsKeyId: KmsIds.KmsKeyId,
})

export type SecretAttributes = typeof SecretAttributesSchema.Type
