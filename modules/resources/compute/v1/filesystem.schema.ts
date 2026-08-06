import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Filesystem Props (user input)
// ---------------------------------------------------------------------------

const FilesystemTypeSchema = Schema.Union([
  Schema.Literal('NETWORK_SSD'),
  Schema.Literal('NETWORK_HDD'),
  Schema.Literal('WEKA'),
  Schema.Literal('VAST'),
])

export const FilesystemPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Size in gibibytes. */
  sizeGibibytes: Schema.Finite,
  /** Block size in bytes. Must be power of two between 4096 and 131072. Default 4096. Immutable after creation. */
  blockSizeBytes: Schema.optional(Schema.Finite.check(Validation.isValidBlockSize)),
  /** Filesystem type. Immutable after creation. */
  type: FilesystemTypeSchema,
  /** Prevents deletion whilst set. */
  forbidDeletion: Schema.optional(Schema.Boolean),
})

export type FilesystemProps = typeof FilesystemPropsSchema.Type

export const validateFilesystemProps = Validation.makeValidateProps(FilesystemPropsSchema)

// ---------------------------------------------------------------------------
// Filesystem Attributes (output)
// ---------------------------------------------------------------------------

export const FilesystemId = Schema.String.pipe(Schema.brand('FilesystemId'))
export type FilesystemId = typeof FilesystemId.Type

export const FilesystemAttributesSchema = Schema.Struct({
  id: FilesystemId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  sizeGibibytes: Schema.Finite,
  blockSizeBytes: Schema.optional(Schema.Finite),
  type: Schema.String,
  forbidDeletion: Schema.optional(Schema.Boolean),
  state: Schema.String,
  stateDescription: Schema.optional(Schema.String),
  reconciling: Schema.optional(Schema.Boolean),
})

export type FilesystemAttributes = typeof FilesystemAttributesSchema.Type
