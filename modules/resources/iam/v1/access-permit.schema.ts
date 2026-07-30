import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as GroupSchema from './group.schema.ts'

// ---------------------------------------------------------------------------
// AccessPermit Props (user input)
// ---------------------------------------------------------------------------

export const AccessPermitPropsSchema = Schema.Struct({
  /** Parent group ID (the subject receiving the permit). Also serves as the identity. */
  parentId: GroupSchema.GroupId,
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The resource ID to grant access to. Immutable after creation. */
  resourceId: Schema.String,
  /** The role to grant. Immutable after creation. */
  role: Schema.String,
})

export type AccessPermitProps = typeof AccessPermitPropsSchema.Type

export const validateAccessPermitProps = Validation.makeValidateProps(AccessPermitPropsSchema)

// ---------------------------------------------------------------------------
// AccessPermit Attributes (output)
// ---------------------------------------------------------------------------

export const AccessPermitId = Schema.String.pipe(Schema.brand('AccessPermitId'))
export type AccessPermitId = typeof AccessPermitId.Type

export const AccessPermitAttributesSchema = Schema.Struct({
  id: AccessPermitId,
  parentId: GroupSchema.GroupId,
  name: Schema.optional(Schema.String),
  resourceId: Schema.String,
  role: Schema.String,
})

export type AccessPermitAttributes = typeof AccessPermitAttributesSchema.Type
