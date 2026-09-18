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

/** Branded ID for Filesystem resources. */
export const FilesystemId = Schema.String.pipe(Schema.brand('FilesystemId'))
export type FilesystemId = typeof FilesystemId.Type

/** Branded ID for Instance resources. */
export const InstanceId = Schema.String.pipe(Schema.brand('InstanceId'))
export type InstanceId = typeof InstanceId.Type

/** Branded ID for GpuCluster resources (InfiniBand fabric membership). */
export const GpuClusterId = Schema.String.pipe(Schema.brand('GpuClusterId'))
export type GpuClusterId = typeof GpuClusterId.Type

/** Branded ID for NVLInstanceGroup resources (NVLink GB200/GB300 groups). */
export const NVLInstanceGroupId = Schema.String.pipe(Schema.brand('NVLInstanceGroupId'))
export type NVLInstanceGroupId = typeof NVLInstanceGroupId.Type
