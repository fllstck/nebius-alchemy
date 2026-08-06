import * as RegionsSchema from '../../regions.schema.ts'
import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'

export const ProjectPropsSchema = Schema.Struct({
  parentId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  region: RegionsSchema.RegionSchema,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export type ProjectProps = typeof ProjectPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateProjectProps = Validation.makeValidateProps(ProjectPropsSchema)

export const ProjectId = Schema.String.check(
  Validation.isResourceId('project-', 'Project'),
).pipe(Schema.brand('ProjectId'))
export type ProjectId = typeof ProjectId.Type

export const TenantId = Schema.String.pipe(Schema.brand('TenantId'))
export type TenantId = typeof TenantId.Type

export const ProjectAttributesSchema = Schema.Struct({
  id: ProjectId,
  parentId: Schema.String,
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
