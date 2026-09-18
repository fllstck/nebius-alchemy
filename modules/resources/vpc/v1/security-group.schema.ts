import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// SecurityGroup Props (user input)
// ---------------------------------------------------------------------------

export const SecurityGroupPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  networkId: Ids.NetworkId,
})

export type SecurityGroupProps = typeof SecurityGroupPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateSecurityGroupProps = Validation.makeValidateProps(SecurityGroupPropsSchema)

// ---------------------------------------------------------------------------
// SecurityGroup Attributes (output)
// ---------------------------------------------------------------------------


export const SecurityGroupAttributesSchema = Schema.Struct({
  id: Ids.SecurityGroupId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  networkId: Ids.NetworkId,
  state: Schema.Union([Schema.Literal('READY')]),
  default: Schema.Boolean,
})

export type SecurityGroupAttributes = typeof SecurityGroupAttributesSchema.Type
