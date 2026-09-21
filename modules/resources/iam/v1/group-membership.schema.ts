import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// GroupMembership Props (user input)
// ---------------------------------------------------------------------------

export const GroupMembershipPropsSchema = Schema.Struct({
  /** Parent group ID (the group this membership belongs to). */
  parentId: Ids.GroupId,
  // No `name` prop: the Nebius API rejects `metadata.name` on memberships
  // (verified live — the provider omits it from every create), so a
  // user-chosen name has no wire field to travel in. The derived
  // `gm-<logicalId>` is only a local label for session notes.
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
  /**
   * When the membership is revoked.
   *
   * ⚠️ Never observed populated by the API: `revokeAfterHours` IS accepted on
   * create (it goes over as an int64 `Long`) and `revokeAt` is a real top-level
   * field of the resource, but both the create response and an immediate `get`
   * returned it undefined (probed live 2026-09-21) — possibly because IAM
   * materialises the schedule asynchronously. The provider maps it explicitly
   * (see `toFriendlyAttributes`); it is not in `status`.
   */
  revokeAt: Schema.optional(Schema.DateFromString),
})

export type GroupMembershipAttributes = typeof GroupMembershipAttributesSchema.Type
