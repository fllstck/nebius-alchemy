import * as Schema from 'effect/Schema'
import * as Ids from './ids.ts'

import * as Validation from '../../validation.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// Image Props (user input)
// ---------------------------------------------------------------------------

const CPUArchitectureSchema = Schema.Union([
  Schema.Literal('AMD64'),
  Schema.Literal('ARM64'),
])

/** Bucket object to create the image from (a third source beside disk/snapshot). */
const SourceStorageSchema = Schema.Struct({
  bucketName: Schema.String,
  objectName: Schema.String,
})

/**
 * The proto declares the create source as a `required` `oneof`: exactly one of
 * `sourceDiskId`, `sourceDiskSnapshotId` or `sourceStorage` must be given.
 */
const exactlyOneImageSource = Schema.makeFilter(
  (props: {
    sourceDiskId?: unknown
    sourceDiskSnapshotId?: unknown
    sourceStorage?: unknown
  }) => {
    const given = (['sourceDiskId', 'sourceDiskSnapshotId', 'sourceStorage'] as const).filter(
      (key) => props[key] !== undefined,
    )
    if (given.length === 1) return undefined
    if (given.length === 0) {
      return 'Image requires exactly one source: sourceDiskId, sourceDiskSnapshotId, or sourceStorage: { bucketName, objectName }'
    }
    return `Image accepts exactly one source, got ${given.length}: ${given.join(', ')}`
  },
  { title: 'exactly one image source' },
)

export const ImagePropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
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
  /** Create the image from an object in a Nebius Object Storage bucket. */
  sourceStorage: Schema.optional(SourceStorageSchema),
  /** CPU architecture supported by the image. Default: AMD64. */
  cpuArchitecture: Schema.optional(CPUArchitectureSchema),
  /** Platforms where this image is recommended. */
  recommendedPlatforms: Schema.optional(Schema.Array(Schema.String)),
}).check(exactlyOneImageSource)

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
  parentId: IamV2Ids.ProjectId,
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
