import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// Subnet Props (user input)
// ---------------------------------------------------------------------------

const SubnetCIDRSchema = Schema.Struct({
  cidr: Schema.String.check(Validation.isValidCIDR),
  state: Schema.optional(
    Schema.Union([Schema.Literal('STATE_UNSPECIFIED'), Schema.Literal('AVAILABLE'), Schema.Literal('DISABLED')]),
  ),
  maxMaskLength: Schema.optional(Schema.Finite),
})

const SubnetPoolSchema = Schema.Struct({
  cidrs: Schema.Array(SubnetCIDRSchema),
})

const IPv4PrivateSubnetPoolsSchema = Schema.Struct({
  pools: Schema.Array(SubnetPoolSchema),
  useNetworkPools: Schema.optional(Schema.Boolean),
})

const IPv4PublicSubnetPoolsSchema = Schema.Struct({
  pools: Schema.Array(SubnetPoolSchema),
  useNetworkPools: Schema.optional(Schema.Boolean),
})

export const SubnetPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  networkId: Ids.NetworkId,
  ipv4PrivatePools: Schema.optional(IPv4PrivateSubnetPoolsSchema),
  ipv4PublicPools: Schema.optional(IPv4PublicSubnetPoolsSchema),
  routeTableId: Schema.optional(Ids.RouteTableId),
})

export type SubnetProps = typeof SubnetPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateSubnetProps = Validation.makeValidateProps(SubnetPropsSchema)

// ---------------------------------------------------------------------------
// Subnet Attributes (output)
// ---------------------------------------------------------------------------

const SubnetAssociatedRouteTableSchema = Schema.Struct({
  id: Ids.RouteTableId,
  default: Schema.Boolean,
})

export const SubnetAttributesSchema = Schema.Struct({
  id: Ids.SubnetId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  networkId: Ids.NetworkId,
  state: Schema.Union([Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('DELETING')]),
  routeTableId: Ids.RouteTableId,
  associatedRouteTable: Schema.optional(SubnetAssociatedRouteTableSchema),
})

export type SubnetAttributes = typeof SubnetAttributesSchema.Type
