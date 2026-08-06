import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// Allocation Props (user input)
// ---------------------------------------------------------------------------

const IPv4AllocationSpecSchema = Schema.Struct({
  cidr: Schema.String.check(Validation.isValidCIDR),
  subnetId: Schema.optional(Ids.SubnetId),
  poolId: Schema.optional(Ids.PoolId),
})

const allocationValid = Schema.makeFilter((props: Record<string, unknown>) => {
  if (!props.ipv4Private && !props.ipv4Public) {
    return { path: [], issue: 'At least one of ipv4Private or ipv4Public must be specified' }
  }
  if (props.ipv4Private && props.ipv4Public) {
    return { path: [], issue: 'Only one of ipv4Private or ipv4Public may be specified, not both' }
  }
})

export const AllocationPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  ipv4Private: Schema.optional(IPv4AllocationSpecSchema),
  ipv4Public: Schema.optional(IPv4AllocationSpecSchema),
}).check(allocationValid)

export type AllocationProps = typeof AllocationPropsSchema.Type

export const validateAllocationProps = Validation.makeValidateProps(AllocationPropsSchema)

// ---------------------------------------------------------------------------
// Allocation Attributes (output)
// ---------------------------------------------------------------------------


export const AllocationAttributesSchema = Schema.Struct({
  id: Ids.AllocationId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  state: Schema.Union([
    Schema.Literal('CREATING'),
    Schema.Literal('ALLOCATED'),
    Schema.Literal('ASSIGNED'),
    Schema.Literal('DELETING'),
  ]),
})

export type AllocationAttributes = typeof AllocationAttributesSchema.Type
