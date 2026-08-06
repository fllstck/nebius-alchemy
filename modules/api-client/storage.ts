import * as Effect from 'effect'
import * as NebiusBucketServiceSchema from '../../schemas/nebius/storage/v1/bucket_service.ts'
import type { Bucket } from '../../schemas/nebius/storage/v1/bucket.ts'
import * as NebiusTransferServiceSchema from '../../schemas/nebius/storage/v1/transfer_service.ts'
import type { Transfer } from '../../schemas/nebius/storage/v1/transfer.ts'
import type { TransferIteration } from '../../schemas/nebius/storage/v1/transfer.ts'
import * as GrpcUtils from './grpc-utils.ts'
import { NebiusGrpcTransport } from './GrpcTransport.ts'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata.ts'
import type { CreateInput, UpdateInput } from './types.ts'

// ---------------------------------------------------------------------------
// Transfer service — operation-aware with Stop/Resume support
// ---------------------------------------------------------------------------

export type CreateTransferInput = CreateInput
export type UpdateTransferInput = UpdateInput

export interface TransferService {
  readonly get: (id: string) => Effect.Effect.Effect<Transfer, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: { parentId: string; name: string }) => Effect.Effect.Effect<Transfer, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (parentId: string) => Effect.Effect.Effect<ReadonlyArray<Transfer>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly create: (req: CreateTransferInput) => Effect.Effect.Effect<Transfer, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly update: (req: UpdateTransferInput) => Effect.Effect.Effect<Transfer, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly delete: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly stop: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly resume: (id: string) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getIterationHistory: (transferId: string) => Effect.Effect.Effect<ReadonlyArray<TransferIteration>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Bucket service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

/** Input for {@link BucketService.create}. */
export type CreateBucketInput = CreateInput

/** Input for {@link BucketService.update}. */
export type UpdateBucketInput = UpdateInput

export interface BucketService {
  readonly get: (id: string) => Effect.Effect.Effect<Bucket, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (
    parentId: string,
    name: string,
  ) => Effect.Effect.Effect<Bucket, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all buckets in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Bucket>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly purge: (
    req: NebiusBucketServiceSchema.PurgeBucketRequest,
  ) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly undelete: (
    req: NebiusBucketServiceSchema.UndeleteBucketRequest,
  ) => Effect.Effect.Effect<void, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateBucketInput,
  ) => Effect.Effect.Effect<
    Bucket,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateBucketInput,
  ) => Effect.Effect.Effect<
    Bucket,
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

export interface StorageGrpcServiceShape {
  readonly bucket: BucketService
  readonly transfer: TransferService
}

export class StorageGrpcService extends Effect.Context.Service<StorageGrpcService, StorageGrpcServiceShape>()(
  'StorageGrpcService',
) {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const StorageGrpcServiceLive = Effect.Layer.effect(
  StorageGrpcService,
  Effect.Effect.gen(function* () {
    const raw = yield* GrpcUtils.makeGrpcService(NebiusBucketServiceSchema.BucketServiceClient)
    const transport = yield* NebiusGrpcTransport

    const polled = GrpcUtils.wrapWithOperationPolling(raw, {
      serviceName: 'nebius.storage.v1.BucketService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusBucketServiceSchema.GetBucketRequest.fromPartial({ id }),
      mapInput: {
        get: (id) => NebiusBucketServiceSchema.GetBucketRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusBucketServiceSchema.GetBucketByNameRequest.fromPartial(req),
        create: (req) => NebiusBucketServiceSchema.CreateBucketRequest.fromPartial(req),
        update: (req) => NebiusBucketServiceSchema.UpdateBucketRequest.fromPartial(req),
        delete: (id) => NebiusBucketServiceSchema.DeleteBucketRequest.fromPartial({ id }),
      },
      // Cast: wrapWithOperationPolling returns WithOperationPolling which has
      // protobuf request types, but BucketService uses simplified inputs
      // (CreateBucketInput, etc.). The mapInput transforms above bridge the
      // gap at runtime; the cast acknowledges the type-level mismatch.
    }) as unknown as BucketService

    // Merge polled operations with the paginating list override.
    const list = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => raw.list(req),
        (parentId, pageToken) =>
          NebiusBucketServiceSchema.ListBucketsRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
        parentId,
      )

    // Cast: same rationale as ProjectService — the spread merges
    // WithOperationPolling with list, and BucketService uses simplified
    // inputs. Verified manually against the interface definition.
    const bucket: BucketService = { ...polled, list }

    // -- Transfer
    const transferRaw = yield* GrpcUtils.makeGrpcService(NebiusTransferServiceSchema.TransferServiceClient)

    const transferPolled = GrpcUtils.wrapWithOperationPolling(transferRaw, {
      serviceName: 'nebius.storage.v1.TransferService',
      polling: ['create', 'update'],
      forget: ['stop', 'resume', 'delete'],
      transport,
      getRequest: (id) => NebiusTransferServiceSchema.GetTransferRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusTransferServiceSchema.GetTransferRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          GetByNameRequest.fromPartial(req),
        create: (req: CreateTransferInput) =>
          NebiusTransferServiceSchema.CreateTransferRequest.fromPartial(req),
        update: (req: UpdateTransferInput) =>
          NebiusTransferServiceSchema.UpdateTransferRequest.fromPartial(req),
        delete: (id: string) => NebiusTransferServiceSchema.DeleteTransferRequest.fromPartial({ id }),
        stop: (id: string) => NebiusTransferServiceSchema.StopTransferRequest.fromPartial({ id }),
        resume: (id: string) => NebiusTransferServiceSchema.ResumeTransferRequest.fromPartial({ id }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

    const transferList = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => transferRaw.list(req),
        (parentId, pageToken) =>
          NebiusTransferServiceSchema.ListTransfersRequest.fromPartial({
            parentId,
            pageSize: 100,
            pageToken,
          }),
        parentId,
      )

    const transfer: TransferService = {
      ...transferPolled,
      list: transferList,
      getIterationHistory: (transferId: string) =>
        Effect.Effect.gen(function* () {
          const response = yield* transferRaw.getIterationHistory(
            NebiusTransferServiceSchema.GetIterationHistoryRequest.fromPartial({
              transferId,
              pageSize: 100,
              pageToken: '',
            }),
          )
          // Response uses `iterations` instead of standard `items`
          return (
            (response as { iterations: TransferIteration[] }).iterations || []
          )
        }),
    }

    return { bucket, transfer }
  }),
)
