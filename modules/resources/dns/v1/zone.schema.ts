import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'
import * as VpcIds from '../../vpc/v1/ids.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Zone Props (user input)
// ---------------------------------------------------------------------------

const VpcZoneScopeSchema = Schema.Struct({
  primaryNetworkId: VpcIds.NetworkId,
})

export const ZonePropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Fully qualified domain name, e.g. "example.com.". Immutable. */
  domainName: Schema.String,
  /** VPC zone scope — zone visible only from the specified network. Required by the API. */
  vpc: VpcZoneScopeSchema,
})

export type ZoneProps = typeof ZonePropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateZoneProps = Validation.makeValidateProps(ZonePropsSchema)

// ---------------------------------------------------------------------------
// Zone Attributes (output)
// ---------------------------------------------------------------------------

export const ZoneId = Schema.String.pipe(Schema.brand('ZoneId'))
export type ZoneId = typeof ZoneId.Type

export const ZoneAttributesSchema = Schema.Struct({
  id: ZoneId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  domainName: Schema.String,
  state: Schema.Literal('READY'),
  recordCount: Schema.optional(Schema.String),
})

export type ZoneAttributes = typeof ZoneAttributesSchema.Type
