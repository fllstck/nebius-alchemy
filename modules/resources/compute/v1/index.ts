export { NebiusDisk as Disk, NebiusDiskProvider as DiskProvider, type NebiusDisk as DiskResource } from './disk.ts'
export { NebiusImage as Image, NebiusImageProvider as ImageProvider, type NebiusImage as ImageResource } from './image.ts'
export { NebiusInstance as Instance, NebiusInstanceProvider as InstanceProvider, type NebiusInstance as InstanceResource } from './instance.ts'
export { NebiusFilesystem as Filesystem, NebiusFilesystemProvider as FilesystemProvider, type NebiusFilesystem as FilesystemResource } from './filesystem.ts'
export { NebiusDiskSnapshot as DiskSnapshot, NebiusDiskSnapshotProvider as DiskSnapshotProvider, type NebiusDiskSnapshot as DiskSnapshotResource } from './disk-snapshot.ts'
export { NebiusGpuCluster as GpuCluster, NebiusGpuClusterProvider as GpuClusterProvider, type NebiusGpuCluster as GpuClusterResource } from './gpu-cluster.ts'
export {
  NebiusNVLInstanceGroup as NVLInstanceGroup,
  NebiusNVLInstanceGroupProvider as NVLInstanceGroupProvider,
  type NebiusNVLInstanceGroup as NVLInstanceGroupResource,
} from './nvl-instance-group.ts'
// Branded-ID constructors (`make`) so callers can brand literal IDs — the same
// surface `vpc/v1` and `iam/*` expose.
export {
  DiskId,
  ImageId,
  DiskSnapshotId,
  FilesystemId,
  InstanceId,
  GpuClusterId,
  NVLInstanceGroupId,
} from './ids.ts'
