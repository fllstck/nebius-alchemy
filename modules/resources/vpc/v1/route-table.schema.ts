import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// RouteTable Props (user input)
// ---------------------------------------------------------------------------

export const RouteTablePropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  networkId: Ids.NetworkId,
})

export type RouteTableProps = typeof RouteTablePropsSchema.Type

export const validateRouteTableProps = Validation.makeValidateProps(RouteTablePropsSchema)

// ---------------------------------------------------------------------------
// RouteTable Attributes (output)
// ---------------------------------------------------------------------------

export const RouteTableAttributesSchema = Schema.Struct({
  id: Ids.RouteTableId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  networkId: Ids.NetworkId,
  state: Schema.Union([Schema.Literal('READY')]),
  default: Schema.Boolean,
  assignment: Schema.optional(Schema.Struct({ subnets: Schema.Array(Ids.SubnetId) })),
})

export type RouteTableAttributes = typeof RouteTableAttributesSchema.Type
