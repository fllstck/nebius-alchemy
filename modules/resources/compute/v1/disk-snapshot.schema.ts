import * as Schema from 'effect/Schema'
import * as Ids from './ids.ts'

import * as Validation from '../../validation.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// DiskSnapshot Props (user input)
// ---------------------------------------------------------------------------

export const DiskSnapshotPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** ID of the source disk. Immutable after creation. */
  sourceDiskId: Ids.DiskId,
  /** Arbitrary description provided by user. */
  description: Schema.optional(Schema.String),
})

export type DiskSnapshotProps = typeof DiskSnapshotPropsSchema.Type

export const validateDiskSnapshotProps = Validation.makeValidateProps(DiskSnapshotPropsSchema)

// ---------------------------------------------------------------------------
// DiskSnapshot Attributes (output)
// ---------------------------------------------------------------------------

export const DiskSnapshotAttributesSchema = Schema.Struct({
  id: Ids.DiskSnapshotId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  sourceDiskId: Ids.DiskId,
  description: Schema.String,
  state: Schema.String,
  contentSizeBytes: Schema.Finite,
  storageSizeBytes: Schema.Finite,
  sourceCpuArchitecture: Schema.optional(Schema.String),
})

export type DiskSnapshotAttributes = typeof DiskSnapshotAttributesSchema.Type
