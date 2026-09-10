import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'
import * as Ids from './ids.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Disk Props (user input)
// ---------------------------------------------------------------------------

const DiskTypeSchema = Schema.Union([
  Schema.Literal('NETWORK_SSD'),
  Schema.Literal('NETWORK_HDD'),
  Schema.Literal('NETWORK_SSD_NON_REPLICATED'),
  Schema.Literal('NETWORK_SSD_IO_M3'),
])

const SourceImageFamilySchema = Schema.Struct({
  imageFamily: Schema.String,
  parentId: Schema.optional(Schema.String),
})

/**
 * Disk encryption configuration.
 *
 * Omitted entirely → the API applies NO encryption (its documented default).
 * The enum string is converted to the protobuf int32 by `DiskSpec.fromJSON`,
 * which recurses into this nested message.
 */
const DiskEncryptionSchema = Schema.Struct({
  type: Schema.Union([
    Schema.Literal('DISK_ENCRYPTION_UNSPECIFIED'),
    Schema.Literal('DISK_ENCRYPTION_MANAGED'),
  ]),
})

/**
 * At most one create source may be given — the API rejects combinations.
 * `sourceImageId` and `sourceImageFamily` are the same source expressed two
 * ways, so they count as one; a snapshot is a distinct source.
 */
const atMostOneDiskSource = Schema.makeFilter(
  (props: {
    sourceImageId?: unknown
    sourceImageFamily?: unknown
    sourceSnapshotId?: unknown
  }) => {
    const hasImage = props.sourceImageId !== undefined || props.sourceImageFamily !== undefined
    const hasSnapshot = props.sourceSnapshotId !== undefined
    if (hasImage && hasSnapshot) {
      return 'Disk accepts only one create source: set either sourceImageId/sourceImageFamily or sourceSnapshotId, not both'
    }
    return undefined
  },
  { title: 'at most one disk source' },
)

export const DiskPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Disk size in gibibytes. One of the size fields must be set. */
  sizeGibibytes: Schema.optional(Schema.Finite),
  /** Block size in bytes. Must be a power of two between 4096 and 131072. Default: 4096. */
  blockSizeBytes: Schema.optional(Schema.Finite),
  /** Disk type determines performance and reliability characteristics. */
  type: DiskTypeSchema,
  /** ID of the source image to create the disk from. */
  sourceImageId: Schema.optional(Ids.ImageId),
  /** Source image family to create the disk from the latest image. */
  sourceImageFamily: Schema.optional(SourceImageFamilySchema),
  /** ID of the disk snapshot to create the disk from (alternative to an image source). */
  sourceSnapshotId: Schema.optional(Ids.DiskSnapshotId),
  /** Encryption configuration. Omitted → no encryption is applied. */
  diskEncryption: Schema.optional(DiskEncryptionSchema),
  /** Prevents deletion whilst set. */
  forbidDeletion: Schema.optional(Schema.Boolean),
}).check(atMostOneDiskSource)

export type DiskProps = typeof DiskPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateDiskProps = Validation.makeValidateProps(DiskPropsSchema)

// ---------------------------------------------------------------------------
// Disk Attributes (output)
// ---------------------------------------------------------------------------

export const DiskAttributesSchema = Schema.Struct({
  id: Ids.DiskId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  type: DiskTypeSchema,
  sizeGibibytes: Schema.optional(Schema.Finite),
  blockSizeBytes: Schema.optional(Schema.Finite),
  sourceImageId: Schema.optional(Ids.ImageId),
  state: Schema.Union([
    Schema.Literal('CREATING'),
    Schema.Literal('READY'),
    Schema.Literal('UPDATING'),
    Schema.Literal('DELETING'),
    Schema.Literal('ERROR'),
    Schema.Literal('BROKEN'),
  ]),
  /** Instance ID that has read-write attachment to this disk. */
  readWriteAttachment: Schema.optional(Schema.String),
})

export type DiskAttributes = typeof DiskAttributesSchema.Type
