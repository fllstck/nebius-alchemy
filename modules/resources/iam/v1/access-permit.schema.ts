import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// AccessPermit Props (user input)
// ---------------------------------------------------------------------------

export const AccessPermitPropsSchema = Schema.Struct({
  /** Parent group ID (the subject receiving the permit). Also serves as the identity. */
  parentId: Ids.GroupId,
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * The resource ID to grant access to. Immutable after creation. Polymorphic:
   * a permit can target any resource type, so it carries its own nominal brand
   * rather than another resource's (see AGENTS.md §"Branded IDs").
   */
  resourceId: Ids.AccessPermitResourceId,
  /** The role to grant. Immutable after creation. */
  role: Schema.String,
})

export type AccessPermitProps = typeof AccessPermitPropsSchema.Type

export const validateAccessPermitProps = Validation.makeValidateProps(AccessPermitPropsSchema)

// ---------------------------------------------------------------------------
// AccessPermit Attributes (output)
// ---------------------------------------------------------------------------

export const AccessPermitAttributesSchema = Schema.Struct({
  id: Ids.AccessPermitId,
  parentId: Ids.GroupId,
  name: Schema.optional(Schema.String),
  resourceId: Ids.AccessPermitResourceId,
  role: Schema.String,
})

export type AccessPermitAttributes = typeof AccessPermitAttributesSchema.Type
