import * as Schema from 'effect/Schema'
import * as RegionsSchema from '../../regions.schema.ts'

import * as Validation from '../../validation.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// QuotaAllowance Props (user input)
// ---------------------------------------------------------------------------

export const QuotaAllowancePropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  /** Quota metric name, e.g. "compute.disk.size.network-ssd". */
  name: Schema.String,
  /** Region where the quota is allocated, e.g. "eu-north1". */
  region: RegionsSchema.RegionSchema,
  /** Requested quota limit. Omit to read-only observe current quota. */
  limit: Schema.optional(Schema.String),
})

export type QuotaAllowanceProps = typeof QuotaAllowancePropsSchema.Type

export const validateQuotaAllowanceProps = Validation.makeValidateProps(QuotaAllowancePropsSchema)

// ---------------------------------------------------------------------------
// QuotaAllowance Attributes (output)
// ---------------------------------------------------------------------------

export const QuotaAllowanceAttributesSchema = Schema.Struct({
  /**
   * NOT branded, and not stable: a QuotaAllowance has no server-assigned ID
   * (identity is `(parentId, name, region)` — see AGENTS.md), and the API can
   * return `""` here.
   */
  id: Schema.String,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  region: RegionsSchema.RegionSchema,
  limit: Schema.String,
  state: Schema.String,
  usage: Schema.String,
  service: Schema.String,
  description: Schema.String,
  serviceDescription: Schema.String,
  unit: Schema.String,
  usagePercentage: Schema.String,
  usageState: Schema.String,
})

export type QuotaAllowanceAttributes = typeof QuotaAllowanceAttributesSchema.Type
