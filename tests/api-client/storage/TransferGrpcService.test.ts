import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as GrpcTransportModule from '../../../modules/api-client/GrpcTransport.ts'
import * as TransferGrpcServiceModule from '../../../modules/api-client/storage.ts'
import * as TransferServiceSchema from '../../../schemas/nebius/storage/v1/transfer_service.ts'
import { fakeChannel } from '../../helpers/channel.ts'

const { describe, expect, test } = BunTest
const { NebiusGrpcTransport } = GrpcTransportModule
const { StorageGrpcService, StorageGrpcServiceLive } = TransferGrpcServiceModule
const { ListTransfersRequest, GetTransferRequest } = TransferServiceSchema

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

/** Fake gRPC channel — pure structural mock, never a real channel. */
const channel = fakeChannel()

/** Mock transport layer — provides a fake channel so service layers can build. */
const mockTransportLayer = Layer.succeed(NebiusGrpcTransport, {
  getChannel: (_endpoint: string) => Effect.succeed(channel),
  channelFor: (_service: string) => Effect.succeed(channel),
  evictChannel: (_endpoint: string) => Effect.void,
})

/** Mock service layer: transport mocked, no credentials needed. */
const mockServiceLayer = StorageGrpcServiceLive.pipe(
  Layer.provide(mockTransportLayer),
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageGrpcService (transfer)', () => {
  describe('layer construction', () => {
    test('builds with mock transport', async () => {
      await Effect.runPromise(
        Effect.scoped(
          Layer.build(mockServiceLayer).pipe(Effect.asVoid),
        ),
      )
    })

    test('exposes all CRUD and lifecycle methods', async () => {
      const svc = await Effect.runPromise(
        Effect.gen(function* () {
          const { transfer: svc } = yield* StorageGrpcService
          return svc
        }).pipe(
          Effect.provide(mockServiceLayer),
          Effect.scoped,
        ),
      )

      expect(typeof svc.get).toBe('function')
      expect(typeof svc.list).toBe('function')
      expect(typeof svc.create).toBe('function')
      expect(typeof svc.update).toBe('function')
      expect(typeof svc.stop).toBe('function')
      expect(typeof svc.resume).toBe('function')
      expect(typeof svc.delete).toBe('function')
      expect(typeof svc.getIterationHistory).toBe('function')
    })

    test('service methods accept valid request types', () => {
      const listReq = ListTransfersRequest.fromPartial({
        parentId: 'project-123',
        pageSize: 10,
        pageToken: '',
      })
      expect(listReq.parentId).toBe('project-123')

      const getReq = GetTransferRequest.fromPartial({ id: 'transfer-789' })
      expect(getReq.id).toBe('transfer-789')
    })
  })
})
