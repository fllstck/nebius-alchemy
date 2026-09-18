import * as RegionsSchema from '../../regions.schema.ts'
import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

export const ProjectPropsSchema = Schema.Struct({
  parentId: Schema.optional(Ids.TenantId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  region: RegionsSchema.RegionSchema,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export type ProjectProps = typeof ProjectPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateProjectProps = Validation.makeValidateProps(ProjectPropsSchema)

export const ProjectAttributesSchema = Schema.Struct({
  id: Ids.ProjectId,
  parentId: Ids.TenantId,
  name: Schema.String,
  region: RegionsSchema.RegionSchema,
  state: Schema.Union([
    Schema.Literal('STATE_UNSPECIFIED'),
    Schema.Literal('CREATING'),
    Schema.Literal('ACTIVE'),
    Schema.Literal('PURGING'),
    Schema.Literal('CREATED'),
    Schema.Literal('ACTIVATING'),
    Schema.Literal('PARKING'),
    Schema.Literal('PARKED'),
  ]),
})

export type ProjectAttributes = typeof ProjectAttributesSchema.Type
