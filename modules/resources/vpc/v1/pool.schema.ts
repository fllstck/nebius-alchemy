import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// Pool Props (user input)
// ---------------------------------------------------------------------------

const PoolCIDRSchema = Schema.Struct({
  cidr: Schema.String.check(Validation.isValidCIDR),
  state: Schema.optional(
    Schema.Union([Schema.Literal('STATE_UNSPECIFIED'), Schema.Literal('AVAILABLE'), Schema.Literal('DISABLED')]),
  ),
  maxMaskLength: Schema.optional(Schema.Finite),
})

export const PoolPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  sourcePoolId: Schema.optional(Ids.PoolId),
  version: Schema.Union([Schema.Literal('IPV4'), Schema.Literal('IPV6')]),
  visibility: Schema.Union([Schema.Literal('PRIVATE'), Schema.Literal('PUBLIC')]),
  cidrs: Schema.Array(PoolCIDRSchema),
})

export type PoolProps = typeof PoolPropsSchema.Type

export const validatePoolProps = Validation.makeValidateProps(PoolPropsSchema)

// ---------------------------------------------------------------------------
// Pool Attributes (output)
// ---------------------------------------------------------------------------

export const PoolAttributesSchema = Schema.Struct({
  id: Ids.PoolId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  version: Schema.Union([Schema.Literal('IPV4'), Schema.Literal('IPV6')]),
  visibility: Schema.Union([Schema.Literal('PRIVATE'), Schema.Literal('PUBLIC')]),
  scopeId: Ids.PoolScopeId,
  state: Schema.Union([Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('DELETING')]),
})

export type PoolAttributes = typeof PoolAttributesSchema.Type
