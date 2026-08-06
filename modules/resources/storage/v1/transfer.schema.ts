import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Transfer Props (user input)
// ---------------------------------------------------------------------------

const AccessKeyCredentialsSchema = Schema.Struct({
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
})

const SourceNebiusSchema = Schema.Struct({
  region: Schema.String,
  bucketName: Schema.String,
  accessKey: Schema.optional(AccessKeyCredentialsSchema),
})

const SourceS3CompatibleSchema = Schema.Struct({
  endpoint: Schema.String,
  region: Schema.String,
  bucketName: Schema.String,
  accessKey: Schema.optional(AccessKeyCredentialsSchema),
})

const SourceAzureBlobSchema = Schema.Struct({
  endpoint: Schema.String,
  containerName: Schema.String,
  accountName: Schema.String,
  accessKey: Schema.String,
})

const TransferSourceSchema = Schema.Union([
  Schema.Struct({ nebius: SourceNebiusSchema }),
  Schema.Struct({ s3Compatible: SourceS3CompatibleSchema }),
  Schema.Struct({ azureBlobStorage: SourceAzureBlobSchema }),
])

const DestinationNebiusSchema = Schema.Struct({
  region: Schema.String,
  bucketName: Schema.String,
  accessKey: AccessKeyCredentialsSchema,
})

const DestinationS3CompatibleSchema = Schema.Struct({
  endpoint: Schema.String,
  region: Schema.String,
  bucketName: Schema.String,
  accessKey: Schema.optional(AccessKeyCredentialsSchema),
})

const TransferDestinationSchema = Schema.Union([
  Schema.Struct({ nebius: DestinationNebiusSchema }),
  Schema.Struct({ s3Compatible: DestinationS3CompatibleSchema }),
])

const LimitersSchema = Schema.Struct({
  bandwidthBytesPerSecond: Schema.optional(Schema.Number),
  requestsPerSecond: Schema.optional(Schema.Number),
})

const OverwriteStrategy = Schema.Union([
  Schema.Literal('NEVER'),
  Schema.Literal('IF_NEWER'),
])

const StopConditionSchema = Schema.Union([
  Schema.Struct({ afterOneIteration: Schema.Literal(true) }),
  Schema.Struct({ afterNEmptyIterations: Schema.Struct({ emptyIterationsThreshold: Schema.Number }) }),
  Schema.Struct({ infinite: Schema.Literal(true) }),
])

export const TransferPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  source: TransferSourceSchema,
  destination: TransferDestinationSchema,
  limiters: Schema.optional(LimitersSchema),
  stopCondition: StopConditionSchema,
  overwriteStrategy: OverwriteStrategy,
  enableDeletesInDestination: Schema.optional(Schema.Boolean),
  touchUnmanaged: Schema.optional(Schema.Boolean),
  /** Seconds between iterations. Default 900 (15 minutes). */
  interIterationIntervalSeconds: Schema.optional(Schema.Number),
})

export type TransferProps = typeof TransferPropsSchema.Type

export const validateTransferProps = Validation.makeValidateProps(TransferPropsSchema)

// ---------------------------------------------------------------------------
// Transfer Attributes (output)
// ---------------------------------------------------------------------------

export const TransferId = Schema.String.pipe(Schema.brand('TransferId'))
export type TransferId = typeof TransferId.Type

export const TransferAttributesSchema = Schema.Struct({
  id: TransferId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  state: Schema.String,
  suspensionState: Schema.optional(Schema.String),
  lastIteration: Schema.optional(
    Schema.Struct({
      sequenceNumber: Schema.Number,
      state: Schema.String,
      objectsTransferredCount: Schema.Number,
      objectsDeletedCount: Schema.Number,
      objectsTransferredSize: Schema.Number,
      startTime: Schema.optional(Schema.DateFromString),
      endTime: Schema.optional(Schema.DateFromString),
    }),
  ),
})

export type TransferAttributes = typeof TransferAttributesSchema.Type
