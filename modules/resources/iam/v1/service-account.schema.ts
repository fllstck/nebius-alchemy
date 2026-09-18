import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../v2/ids.ts'

// ---------------------------------------------------------------------------
// ServiceAccount Props (user input)
// ---------------------------------------------------------------------------

export const ServiceAccountPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
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

export const ServiceAccountAttributesSchema = Schema.Struct({
  id: Ids.ServiceAccountId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  description: Schema.String,
  active: Schema.Boolean,
})

export type ServiceAccountAttributes = typeof ServiceAccountAttributesSchema.Type
