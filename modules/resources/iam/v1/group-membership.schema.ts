import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// GroupMembership Props (user input)
// ---------------------------------------------------------------------------

export const GroupMembershipPropsSchema = Schema.Struct({
  /** Parent group ID (the group this membership belongs to). */
  parentId: Ids.GroupId,
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * The member ID. Immutable after creation. Polymorphic but closed: the proto's
   * `GroupMemberKind.Kind` allows a tenant user account or a service account
   * (see `ids.ts` for why this is a union of brands, not a nominal brand).
   */
  memberId: Ids.GroupMembershipMemberId,
  /** Optional duration in hours after which the membership is revoked. */
  revokeAfterHours: Schema.optional(Schema.Finite),
})

export type GroupMembershipProps = typeof GroupMembershipPropsSchema.Type

export const validateGroupMembershipProps = Validation.makeValidateProps(GroupMembershipPropsSchema)

// ---------------------------------------------------------------------------
// GroupMembership Attributes (output)
// ---------------------------------------------------------------------------

export const GroupMembershipAttributesSchema = Schema.Struct({
  id: Ids.GroupMembershipId,
  parentId: Ids.GroupId,
  name: Schema.String,
  memberId: Ids.GroupMembershipMemberId,
  memberKind: Schema.optional(Schema.String),
  revokeAt: Schema.optional(Schema.DateFromString),
})

export type GroupMembershipAttributes = typeof GroupMembershipAttributesSchema.Type
