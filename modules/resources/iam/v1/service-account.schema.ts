import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../v2/project.schema.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// ServiceAccount Props (user input)
// ---------------------------------------------------------------------------

export const ServiceAccountPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optional(Schema.String),
})

export type ServiceAccountProps = typeof ServiceAccountPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateServiceAccountProps = Validation.makeValidateProps(ServiceAccountPropsSchema)

// ---------------------------------------------------------------------------
// ServiceAccount Attributes (output)
// ---------------------------------------------------------------------------

export const ServiceAccountId = Schema.String.check(
  Validation.isResourceId('serviceaccount-', 'ServiceAccount'),
).pipe(Schema.brand('ServiceAccountId'))
export type ServiceAccountId = typeof ServiceAccountId.Type

export const ServiceAccountAttributesSchema = Schema.Struct({
  id: ServiceAccountId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  description: Schema.String,
  active: Schema.Boolean,
})

export type ServiceAccountAttributes = typeof ServiceAccountAttributesSchema.Type
