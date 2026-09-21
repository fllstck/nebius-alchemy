import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// SecretVersion Props (user input)
// ---------------------------------------------------------------------------

const PayloadEntrySchema = Schema.Struct({
  key: Schema.String,
  stringValue: Schema.optional(Schema.String),
})

export const SecretVersionPropsSchema = Schema.Struct({
  /** Parent secret ID. */
  parentId: Ids.SecretId,
  /**
   * Physical name (`metadata.name`). Immutable — the service has no Update RPC,
   * so a change replaces the version. Defaults to `sv-<logicalId>`.
   */
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optional(Schema.String),
  /** Payload entries for this version. Immutable after creation. */
  payload: Schema.Array(PayloadEntrySchema),
  /** If true, set this version as primary after creation. */
  setPrimary: Schema.optional(Schema.Boolean),
})

export type SecretVersionProps = typeof SecretVersionPropsSchema.Type

export const validateSecretVersionProps = Validation.makeValidateProps(SecretVersionPropsSchema)

// ---------------------------------------------------------------------------
// SecretVersion Attributes (output)
// ---------------------------------------------------------------------------

export const SecretVersionAttributesSchema = Schema.Struct({
  id: Ids.SecretVersionId,
  parentId: Ids.SecretId,
  name: Schema.String,
  description: Schema.String,
  state: Schema.String,
  deletedAt: Schema.optional(Schema.DateFromString),
  purgeAt: Schema.optional(Schema.DateFromString),
})

export type SecretVersionAttributes = typeof SecretVersionAttributesSchema.Type
