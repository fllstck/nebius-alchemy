import * as Schema from 'effect/Schema'

/** Branded ID for Disk resources. */
export const DiskId = Schema.String.pipe(Schema.brand('DiskId'))
export type DiskId = typeof DiskId.Type

/** Branded ID for Image resources. */
export const ImageId = Schema.String.pipe(Schema.brand('ImageId'))
export type ImageId = typeof ImageId.Type

/** Branded ID for DiskSnapshot resources. */
export const DiskSnapshotId = Schema.String.pipe(Schema.brand('DiskSnapshotId'))
export type DiskSnapshotId = typeof DiskSnapshotId.Type

/** Branded ID for Instance resources. */
export const InstanceId = Schema.String.pipe(Schema.brand('InstanceId'))
export type InstanceId = typeof InstanceId.Type
