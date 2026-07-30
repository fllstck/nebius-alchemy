import * as Effect from 'effect'
import * as NebiusZoneServiceSchema from '../../schemas/nebius/dns/v1/zone_service'
import type { Zone } from '../../schemas/nebius/dns/v1/zone'
import {
  GetZoneRequest,
  CreateZoneRequest,
  UpdateZoneRequest,
  DeleteZoneRequest,
  ListZonesRequest,
} from '../../schemas/nebius/dns/v1/zone'
import * as NebiusRecordServiceSchema from '../../schemas/nebius/dns/v1/record_service'
import type { Record as DnsRecord } from '../../schemas/nebius/dns/v1/record'
import {
  GetRecordRequest,
  CreateRecordRequest,
  UpdateRecordRequest,
  DeleteRecordRequest,
  ListRecordsRequest,
} from '../../schemas/nebius/dns/v1/record'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata'
import * as GrpcUtils from './grpc-utils'
import { NebiusGrpcTransport } from './GrpcTransport'
import type { CreateInput, UpdateInput } from './types'

// ---------------------------------------------------------------------------
// Zone service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateZoneInput = CreateInput

export type UpdateZoneInput = UpdateInput

export interface ZoneService {
  readonly get: (id: string) => Effect.Effect.Effect<Zone, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (
    parentId: string,
    name: string,
  ) => Effect.Effect.Effect<Zone, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all zones in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Zone>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  readonly create: (
    req: CreateZoneInput,
  ) => Effect.Effect.Effect<
    Zone,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateZoneInput,
  ) => Effect.Effect.Effect<
    Zone,
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
// Record service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export interface CreateRecordInput {
  readonly metadata: { parentId: string; name?: string; labels?: Record<string, string> }
  readonly spec: {}
}

export type UpdateRecordInput = UpdateInput

export interface RecordService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<DnsRecord, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (
    parentId: string,
    name: string,
  ) => Effect.Effect.Effect<DnsRecord, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all records in a zone (paginates automatically). Uses zone ID as parent. */
  readonly list: (
    zoneId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<DnsRecord>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  readonly create: (
    req: CreateRecordInput,
  ) => Effect.Effect.Effect<
    DnsRecord,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateRecordInput,
  ) => Effect.Effect.Effect<
    DnsRecord,
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

export interface DnsGrpcServiceShape {
  readonly zone: ZoneService
  readonly record: RecordService
}

export class DnsGrpcService extends Effect.Context.Service<DnsGrpcService, DnsGrpcServiceShape>()('DnsGrpcService') {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

const makeZoneService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusZoneServiceSchema.ZoneServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.dns.v1.ZoneService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => GetZoneRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => GetZoneRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateZoneInput) => CreateZoneRequest.fromPartial(req),
      update: (req: UpdateZoneInput) => UpdateZoneRequest.fromPartial(req),
      delete: (id: string) => DeleteZoneRequest.fromPartial({ id }),
    },
  }) as unknown as ZoneService

  const list = (
    parentId: string,
  ): Effect.Effect.Effect<Zone[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (parentId, pageToken) => ListZonesRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
      parentId,
    )

  return { ...polled, list }
})

const makeRecordService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusRecordServiceSchema.RecordServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.dns.v1.RecordService',
    polling: ['create', 'update'],
    forget: ['delete'],
    transport,
    getRequest: (id) => GetRecordRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => GetRecordRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateRecordInput) => CreateRecordRequest.fromPartial(req),
      update: (req: UpdateRecordInput) => UpdateRecordRequest.fromPartial(req),
      delete: (id: string) => DeleteRecordRequest.fromPartial({ id }),
    },
  }) as unknown as RecordService

  const list = (
    zoneId: string,
  ): Effect.Effect.Effect<DnsRecord[], GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError> =>
    GrpcUtils.paginateAll(
      (req) => raw.list(req),
      (zoneId, pageToken) => ListRecordsRequest.fromPartial({ parentId: zoneId, pageSize: 100, pageToken }),
      zoneId,
    )

  return { ...polled, list }
})

export const DnsGrpcServiceLive = Effect.Layer.effect(
  DnsGrpcService,
  Effect.Effect.gen(function* () {
    const zone = yield* makeZoneService
    const record = yield* makeRecordService

    return { zone, record }
  }),
)
