import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// Network Props (user input)
// ---------------------------------------------------------------------------

const NetworkPoolSchema = Schema.Struct({
  id: Ids.PoolId,
})

const IPv4PrivatePoolsSchema = Schema.Struct({
  pools: Schema.Array(NetworkPoolSchema),
})

const IPv4PublicPoolsSchema = Schema.Struct({
  pools: Schema.Array(NetworkPoolSchema),
})

export const NetworkPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  ipv4PrivatePools: Schema.optional(IPv4PrivatePoolsSchema),
  ipv4PublicPools: Schema.optional(IPv4PublicPoolsSchema),
})

export type NetworkProps = typeof NetworkPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateNetworkProps = Validation.makeValidateProps(NetworkPropsSchema)

// ---------------------------------------------------------------------------
// Network Attributes (output)
// ---------------------------------------------------------------------------

// Re-export for consumers
export const NetworkAttributesSchema = Schema.Struct({
  id: Ids.NetworkId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  state: Schema.Union([Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('DELETING')]),
  defaultRouteTableId: Ids.RouteTableId,
})

export type NetworkAttributes = typeof NetworkAttributesSchema.Type
