import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'
import * as Ids from './ids.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Image Props (user input)
// ---------------------------------------------------------------------------

const CPUArchitectureSchema = Schema.Union([
  Schema.Literal('AMD64'),
  Schema.Literal('ARM64'),
])

export const ImagePropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Human-readable description of the image. */
  description: Schema.optional(Schema.String),
  /** Image family name for grouping related images. */
  imageFamily: Schema.optional(Schema.String),
  /** Version identifier within the image family. */
  version: Schema.optional(Schema.String),
  /** Human-readable name for the image family. */
  imageFamilyHumanReadable: Schema.optional(Schema.String),
  /** ID of the disk to create the image from. */
  sourceDiskId: Schema.optional(Ids.DiskId),
  /** ID of the disk snapshot to create the image from. */
  sourceDiskSnapshotId: Schema.optional(Ids.DiskSnapshotId),
  /** CPU architecture supported by the image. Default: AMD64. */
  cpuArchitecture: Schema.optional(CPUArchitectureSchema),
  /** Platforms where this image is recommended. */
  recommendedPlatforms: Schema.optional(Schema.Array(Schema.String)),
}).check(
  Schema.makeFilter((props: Record<string, unknown>) => {
    if (!props.sourceDiskId && !props.sourceDiskSnapshotId) {
      return { path: [], issue: 'At least one of sourceDiskId or sourceDiskSnapshotId must be specified' }
    }
  }),
)

export type ImageProps = typeof ImagePropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateImageProps = Validation.makeValidateProps(ImagePropsSchema)

// ---------------------------------------------------------------------------
// Image Attributes (output)
// ---------------------------------------------------------------------------

export const ImageAttributesSchema = Schema.Struct({
  id: Ids.ImageId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  description: Schema.optional(Schema.String),
  imageFamily: Schema.optional(Schema.String),
  state: Schema.Union([
    Schema.Literal('CREATING'),
    Schema.Literal('READY'),
    Schema.Literal('UPDATING'),
    Schema.Literal('DELETING'),
    Schema.Literal('ERROR'),
  ]),
  storageSizeBytes: Schema.optional(Schema.String),
  minDiskSizeBytes: Schema.optional(Schema.String),
})

export type ImageAttributes = typeof ImageAttributesSchema.Type
