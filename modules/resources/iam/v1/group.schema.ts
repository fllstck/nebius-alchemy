import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../v2/ids.ts'

// ---------------------------------------------------------------------------
// Group Props (user input)
// ---------------------------------------------------------------------------

export const GroupPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export type GroupProps = typeof GroupPropsSchema.Type

export const validateGroupProps = Validation.makeValidateProps(GroupPropsSchema)

// ---------------------------------------------------------------------------
// Group Attributes (output)
// ---------------------------------------------------------------------------

export const GroupAttributesSchema = Schema.Struct({
  id: Ids.GroupId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  state: Schema.String,
  membersCount: Schema.Number,
  serviceAccountsCount: Schema.Number,
  tenantUserAccountsCount: Schema.Number,
})

export type GroupAttributes = typeof GroupAttributesSchema.Type
