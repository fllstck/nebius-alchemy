import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as GroupSchema from './group.schema.ts'

// ---------------------------------------------------------------------------
// GroupMembership Props (user input)
// ---------------------------------------------------------------------------

export const GroupMembershipPropsSchema = Schema.Struct({
  /** Parent group ID (the group this membership belongs to). */
  parentId: GroupSchema.GroupId,
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The member ID (tenant user account or service account). Immutable after creation. */
  memberId: Schema.String,
  /** Optional duration in hours after which the membership is revoked. */
  revokeAfterHours: Schema.optional(Schema.Finite),
})

export type GroupMembershipProps = typeof GroupMembershipPropsSchema.Type

export const validateGroupMembershipProps = Validation.makeValidateProps(GroupMembershipPropsSchema)

// ---------------------------------------------------------------------------
// GroupMembership Attributes (output)
// ---------------------------------------------------------------------------

export const GroupMembershipId = Schema.String.pipe(Schema.brand('GroupMembershipId'))
export type GroupMembershipId = typeof GroupMembershipId.Type

export const GroupMembershipAttributesSchema = Schema.Struct({
  id: GroupMembershipId,
  parentId: GroupSchema.GroupId,
  name: Schema.String,
  memberId: Schema.String,
  memberKind: Schema.optional(Schema.String),
  revokeAt: Schema.optional(Schema.DateFromString),
})

export type GroupMembershipAttributes = typeof GroupMembershipAttributesSchema.Type
