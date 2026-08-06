import * as Effect from 'effect'
import * as NebiusJobServiceSchema from '../../schemas/nebius/ai/v1/job_service.ts'
import type { Job } from '../../schemas/nebius/ai/v1/job.ts'
import * as NebiusEndpointServiceSchema from '../../schemas/nebius/ai/v1/endpoint_service.ts'
import type { Endpoint } from '../../schemas/nebius/ai/v1/endpoint.ts'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata.ts'
import * as GrpcUtils from './grpc-utils.ts'
import { NebiusGrpcTransport } from './GrpcTransport.ts'
import type { CreateInput } from './types.ts'

// ---------------------------------------------------------------------------
// Job service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateJobInput = CreateInput

export interface JobService {
  readonly get: (id: string) => Effect.Effect.Effect<Job, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Job, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all jobs in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Job>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateJobInput,
  ) => Effect.Effect.Effect<
    Job,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly cancel: (
    id: string,
  ) => Effect.Effect.Effect<
    Job,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Endpoint service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateEndpointInput = CreateInput

export interface EndpointService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<Endpoint, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Endpoint, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all endpoints in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Endpoint>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateEndpointInput,
  ) => Effect.Effect.Effect<
    Endpoint,
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
    Endpoint,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly stop: (
    id: string,
  ) => Effect.Effect.Effect<
    Endpoint,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface AiGrpcServiceShape {
  readonly job: JobService
  readonly endpoint: EndpointService
}

export class AiGrpcService extends Effect.Context.Service<AiGrpcService, AiGrpcServiceShape>()('AiGrpcService') {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

const makeJobService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusJobServiceSchema.JobServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.ai.v1.JobService',
    polling: ['create', 'cancel'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusJobServiceSchema.GetJobRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusJobServiceSchema.GetJobRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateJobInput) => NebiusJobServiceSchema.CreateJobRequest.fromPartial(req),
      delete: (id: string) => NebiusJobServiceSchema.DeleteJobRequest.fromPartial({ id }),
      cancel: (id: string) => NebiusJobServiceSchema.CancelJobRequest.fromPartial({ id }),
    },
  }) as unknown as JobService

  // Wrap list with pagination
  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusJobServiceSchema.ListJobsRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
      parentId,
    )

  return { ...polled, list }
})

const makeEndpointService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusEndpointServiceSchema.EndpointServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.ai.v1.EndpointService',
    // Mirrors InstanceService: create/start/stop are long-running operations.
    polling: ['create', 'start', 'stop'],
    forget: ['delete'],
    transport,
    getRequest: (id) => NebiusEndpointServiceSchema.GetEndpointRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => NebiusEndpointServiceSchema.GetEndpointRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateEndpointInput) => NebiusEndpointServiceSchema.CreateEndpointRequest.fromPartial(req),
      delete: (id: string) => NebiusEndpointServiceSchema.DeleteEndpointRequest.fromPartial({ id }),
      start: (id: string) => NebiusEndpointServiceSchema.StartEndpointRequest.fromPartial({ id }),
      stop: (id: string) => NebiusEndpointServiceSchema.StopEndpointRequest.fromPartial({ id }),
    },
  }) as unknown as EndpointService

  // Wrap list with pagination
  const list = (parentId: string) =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) =>
        NebiusEndpointServiceSchema.ListEndpointsRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
      parentId,
    )

  return { ...polled, list }
})

export const AiGrpcServiceLive = Effect.Layer.effect(
  AiGrpcService,
  Effect.Effect.gen(function* () {
    const job = yield* makeJobService
    const endpoint = yield* makeEndpointService

    return { job, endpoint }
  }),
)
