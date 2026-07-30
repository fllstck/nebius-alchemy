import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// Route Props (user input)
// ---------------------------------------------------------------------------

const DestinationMatchSchema = Schema.Struct({
  cidr: Schema.String.check(Validation.isValidCIDR),
})

const AllocationNextHopSchema = Schema.Struct({
  id: Ids.AllocationId,
})

const NextHopSchema = Schema.Struct({
  allocation: Schema.optional(AllocationNextHopSchema),
  defaultEgressGateway: Schema.optional(Schema.Boolean),
})

export const RoutePropsSchema = Schema.Struct({
  parentId: Ids.RouteTableId,
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  destination: Schema.optional(DestinationMatchSchema),
  nextHop: Schema.optional(NextHopSchema),
  description: Schema.optional(Schema.String),
})

export type RouteProps = typeof RoutePropsSchema.Type

export const validateRouteProps = Validation.makeValidateProps(RoutePropsSchema)

// ---------------------------------------------------------------------------
// Route Attributes (output)
// ---------------------------------------------------------------------------


export const RouteAttributesSchema = Schema.Struct({
  id: Ids.RouteId,
  parentId: Ids.RouteTableId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  description: Schema.String,
  state: Schema.Union([Schema.Literal('READY')]),
})

export type RouteAttributes = typeof RouteAttributesSchema.Type
