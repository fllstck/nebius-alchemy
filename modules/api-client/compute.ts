import * as Effect from 'effect'
import * as NebiusDiskServiceSchema from '../../schemas/nebius/compute/v1/disk_service.ts'
import type { Disk } from '../../schemas/nebius/compute/v1/disk.ts'
import * as NebiusImageServiceSchema from '../../schemas/nebius/compute/v1/image_service.ts'
import type { Image } from '../../schemas/nebius/compute/v1/image.ts'
import * as NebiusInstanceServiceSchema from '../../schemas/nebius/compute/v1/instance_service.ts'
import type { Instance } from '../../schemas/nebius/compute/v1/instance.ts'
import * as NebiusFilesystemServiceSchema from '../../schemas/nebius/compute/v1/filesystem_service.ts'
import type { Filesystem } from '../../schemas/nebius/compute/v1/filesystem.ts'
import * as NebiusDiskSnapshotServiceSchema from '../../schemas/nebius/compute/v1/disk_snapshot_service.ts'
import type { DiskSnapshot } from '../../schemas/nebius/compute/v1/disk_snapshot.ts'
import * as NebiusGpuClusterServiceSchema from '../../schemas/nebius/compute/v1/gpu_cluster_service.ts'
import type { GpuCluster } from '../../schemas/nebius/compute/v1/gpu_cluster.ts'
import * as NebiusNVLInstanceGroupServiceSchema from '../../schemas/nebius/compute/v1/nvlinstancegroup_service.ts'
import type { NVLInstanceGroup } from '../../schemas/nebius/compute/v1/nvlinstancegroup.ts'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata.ts'
import * as GrpcUtils from './grpc-utils.ts'
import { NebiusGrpcTransport } from './GrpcTransport.ts'
import type { CreateInput, UpdateInput } from './types.ts'

// ---------------------------------------------------------------------------
// Disk service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateDiskInput = CreateInput

export type UpdateDiskInput = UpdateInput

export interface DiskService {
  readonly get: (id: string) => Effect.Effect.Effect<Disk, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (
    parentId: string,
    name: string,
  ) => Effect.Effect.Effect<Disk, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all disks in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Disk>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateDiskInput,
  ) => Effect.Effect.Effect<
    Disk,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateDiskInput,
  ) => Effect.Effect.Effect<
    Disk,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Image service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateImageInput = CreateInput

export type UpdateImageInput = UpdateInput

export interface ImageService {
  readonly get: (id: string) => Effect.Effect.Effect<Image, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getLatestByFamily: (
    req: { parentId: string; imageFamily: string },
  ) => Effect.Effect.Effect<Image, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all images in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Image>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateImageInput,
  ) => Effect.Effect.Effect<
    Image,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateImageInput,
  ) => Effect.Effect.Effect<
    Image,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Instance service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateInstanceInput = CreateInput

export type UpdateInstanceInput = UpdateInput

export interface InstanceService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<Instance, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Instance, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all instances in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Instance>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateInstanceInput,
  ) => Effect.Effect.Effect<
    Instance,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateInstanceInput,
  ) => Effect.Effect.Effect<
    Instance,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly start: (
    id: string,
  ) => Effect.Effect.Effect<
    Instance,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly stop: (
    id: string,
  ) => Effect.Effect.Effect<
    Instance,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Filesystem service — standard CRUD
// ---------------------------------------------------------------------------

export type CreateFilesystemInput = CreateInput
export type UpdateFilesystemInput = UpdateInput

export interface FilesystemService {
  readonly get: (id: string) => Effect.Effect.Effect<Filesystem, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string }) => Effect.Effect.Effect<Filesystem, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<Filesystem>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateFilesystemInput) => Effect.Effect.Effect<Filesystem, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateFilesystemInput) => Effect.Effect.Effect<Filesystem, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// DiskSnapshot service — standard CRUD
// ---------------------------------------------------------------------------

export type CreateDiskSnapshotInput = CreateInput
export type UpdateDiskSnapshotInput = UpdateInput

export interface DiskSnapshotService {
  readonly get: (id: string) => Effect.Effect.Effect<DiskSnapshot, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string }) => Effect.Effect.Effect<DiskSnapshot, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<DiskSnapshot>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateDiskSnapshotInput) => Effect.Effect.Effect<DiskSnapshot, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateDiskSnapshotInput) => Effect.Effect.Effect<DiskSnapshot, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// GpuCluster service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateGpuClusterInput = CreateInput

export type UpdateGpuClusterInput = UpdateInput

export interface GpuClusterService {
  readonly get: (id: string) => Effect.Effect.Effect<GpuCluster, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all GPU clusters in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<GpuCluster>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateGpuClusterInput,
  ) => Effect.Effect.Effect<
    GpuCluster,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  /**
   * The RPC exists (and is wrapped), but `GpuClusterSpec` currently carries a
   * single immutable field (`infinibandFabric`), so the provider never calls it.
   */
  readonly update: (
    req: UpdateGpuClusterInput,
  ) => Effect.Effect.Effect<
    GpuCluster,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// NVLInstanceGroup service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateNVLInstanceGroupInput = CreateInput

export type UpdateNVLInstanceGroupInput = UpdateInput

export interface NVLInstanceGroupService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<NVLInstanceGroup, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all NVLink instance groups in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<NVLInstanceGroup>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateNVLInstanceGroupInput,
  ) => Effect.Effect.Effect<
    NVLInstanceGroup,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateNVLInstanceGroupInput,
  ) => Effect.Effect.Effect<
    NVLInstanceGroup,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface ComputeGrpcServiceShape {
  readonly disk: DiskService
  readonly image: ImageService
  readonly instance: InstanceService
  readonly filesystem: FilesystemService
  readonly diskSnapshot: DiskSnapshotService
  readonly gpuCluster: GpuClusterService
  readonly nvlInstanceGroup: NVLInstanceGroupService
}

export class ComputeGrpcService extends Effect.Context.Service<ComputeGrpcService, ComputeGrpcServiceShape>()(
  'ComputeGrpcService',
) {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

const makeDiskService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusDiskServiceSchema.DiskServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.compute.v1.DiskService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusDiskServiceSchema.GetDiskRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusDiskServiceSchema.GetDiskRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateDiskInput) => NebiusDiskServiceSchema.CreateDiskRequest.fromPartial(req),
      update: (req: UpdateDiskInput) => NebiusDiskServiceSchema.UpdateDiskRequest.fromPartial(req),
      delete: (id: string) => NebiusDiskServiceSchema.DeleteDiskRequest.fromPartial({ id }),
    },
  }) as unknown as DiskService

  // Wrap list with pagination
  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusDiskServiceSchema.ListDisksRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
      parentId,
    )

  return { ...polled, list }
})

const makeImageService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusImageServiceSchema.ImageServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.compute.v1.ImageService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusImageServiceSchema.GetImageRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusImageServiceSchema.GetImageRequest.fromPartial({ id }),
      getLatestByFamily: (req: { parentId: string; imageFamily: string }) =>
        NebiusImageServiceSchema.GetImageLatestByFamilyRequest.fromPartial(req),
      create: (req: CreateImageInput) => NebiusImageServiceSchema.CreateImageRequest.fromPartial(req),
      update: (req: UpdateImageInput) => NebiusImageServiceSchema.UpdateImageRequest.fromPartial(req),
      delete: (id: string) => NebiusImageServiceSchema.DeleteImageRequest.fromPartial({ id }),
    },
  }) as unknown as ImageService

  // Wrap list with pagination
  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusImageServiceSchema.ListImagesRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
      parentId,
    )

  return { ...polled, list }
})

const makeInstanceService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusInstanceServiceSchema.InstanceServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.compute.v1.InstanceService',
    polling: ['create', 'update', 'start', 'stop'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusInstanceServiceSchema.GetInstanceRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusInstanceServiceSchema.GetInstanceRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateInstanceInput) => NebiusInstanceServiceSchema.CreateInstanceRequest.fromPartial(req),
      update: (req: UpdateInstanceInput) => NebiusInstanceServiceSchema.UpdateInstanceRequest.fromPartial(req),
      delete: (id: string) => NebiusInstanceServiceSchema.DeleteInstanceRequest.fromPartial({ id }),
      start: (id: string) => NebiusInstanceServiceSchema.StartInstanceRequest.fromPartial({ id }),
      stop: (id: string) => NebiusInstanceServiceSchema.StopInstanceRequest.fromPartial({ id }),
    },
  }) as unknown as InstanceService

  // Wrap list with pagination
  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusInstanceServiceSchema.ListInstancesRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
      parentId,
    )

  return { ...polled, list }
})

// -- Filesystem ------------------------------------------------------------

const makeFilesystemService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusFilesystemServiceSchema.FilesystemServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.compute.v1.FilesystemService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusFilesystemServiceSchema.GetFilesystemRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusFilesystemServiceSchema.GetFilesystemRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateFilesystemInput) =>
        NebiusFilesystemServiceSchema.CreateFilesystemRequest.fromPartial(req),
      update: (req: UpdateFilesystemInput) =>
        NebiusFilesystemServiceSchema.UpdateFilesystemRequest.fromPartial(req),
      delete: (id: string) => NebiusFilesystemServiceSchema.DeleteFilesystemRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusFilesystemServiceSchema.ListFilesystemsRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as FilesystemService
})

// -- DiskSnapshot ----------------------------------------------------------

const makeDiskSnapshotService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusDiskSnapshotServiceSchema.DiskSnapshotServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.compute.v1.DiskSnapshotService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusDiskSnapshotServiceSchema.GetDiskSnapshotRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusDiskSnapshotServiceSchema.GetDiskSnapshotRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateDiskSnapshotInput) =>
        NebiusDiskSnapshotServiceSchema.CreateDiskSnapshotRequest.fromPartial(req),
      update: (req: UpdateDiskSnapshotInput) =>
        NebiusDiskSnapshotServiceSchema.UpdateDiskSnapshotRequest.fromPartial(req),
      delete: (id: string) =>
        NebiusDiskSnapshotServiceSchema.DeleteDiskSnapshotRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusDiskSnapshotServiceSchema.ListDiskSnapshotsRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as DiskSnapshotService
})

const makeGpuClusterService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusGpuClusterServiceSchema.GpuClusterServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.compute.v1.GpuClusterService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusGpuClusterServiceSchema.GetGpuClusterRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusGpuClusterServiceSchema.GetGpuClusterRequest.fromPartial({ id }),
      create: (req: CreateGpuClusterInput) => NebiusGpuClusterServiceSchema.CreateGpuClusterRequest.fromPartial(req),
      update: (req: UpdateGpuClusterInput) => NebiusGpuClusterServiceSchema.UpdateGpuClusterRequest.fromPartial(req),
      delete: (id: string) => NebiusGpuClusterServiceSchema.DeleteGpuClusterRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusGpuClusterServiceSchema.ListGpuClustersRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as GpuClusterService
})

const makeNVLInstanceGroupService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusNVLInstanceGroupServiceSchema.NVLInstanceGroupServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.compute.v1.NVLInstanceGroupService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusNVLInstanceGroupServiceSchema.GetNVLInstanceGroupRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusNVLInstanceGroupServiceSchema.GetNVLInstanceGroupRequest.fromPartial({ id }),
      create: (req: CreateNVLInstanceGroupInput) =>
        NebiusNVLInstanceGroupServiceSchema.CreateNVLInstanceGroupRequest.fromPartial(req),
      update: (req: UpdateNVLInstanceGroupInput) =>
        NebiusNVLInstanceGroupServiceSchema.UpdateNVLInstanceGroupRequest.fromPartial(req),
      delete: (id: string) => NebiusNVLInstanceGroupServiceSchema.DeleteNVLInstanceGroupRequest.fromPartial({ id }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusNVLInstanceGroupServiceSchema.ListNVLInstanceGroupsRequest.fromPartial({
          parentId,
          pageSize: 100,
          pageToken,
        }),
      parentId,
    )

  return { ...polled, list } as unknown as NVLInstanceGroupService
})

export const ComputeGrpcServiceLive = Effect.Layer.effect(
  ComputeGrpcService,
  Effect.Effect.gen(function* () {
    const disk = yield* makeDiskService
    const image = yield* makeImageService
    const instance = yield* makeInstanceService
    const filesystem = yield* makeFilesystemService
    const diskSnapshot = yield* makeDiskSnapshotService
    const gpuCluster = yield* makeGpuClusterService
    const nvlInstanceGroup = yield* makeNVLInstanceGroupService

    return { disk, image, instance, filesystem, diskSnapshot, gpuCluster, nvlInstanceGroup }
  }),
)
