import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../v2/project.schema.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Group Props (user input)
// ---------------------------------------------------------------------------

export const GroupPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export type GroupProps = typeof GroupPropsSchema.Type

export const validateGroupProps = Validation.makeValidateProps(GroupPropsSchema)

// ---------------------------------------------------------------------------
// Group Attributes (output)
// ---------------------------------------------------------------------------

export const GroupId = Schema.String.pipe(Schema.brand('GroupId'))
export type GroupId = typeof GroupId.Type

export const GroupAttributesSchema = Schema.Struct({
  id: GroupId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  state: Schema.String,
  membersCount: Schema.Number,
  serviceAccountsCount: Schema.Number,
  tenantUserAccountsCount: Schema.Number,
})

export type GroupAttributes = typeof GroupAttributesSchema.Type
