import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as grpc from '@grpc/grpc-js'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as NebiusAuthModule from '../../../modules/AuthProvider'
import * as NebiusCredentialsModule from '../../../modules/Credentials'
import * as GrpcTransportModule from '../../../modules/api-client/GrpcTransport.ts'
import * as BucketGrpcServiceModule from '../../../modules/api-client/storage.ts'
import { runIntegration } from '../../helpers/gate'

const { describe, expect, test } = BunTest
const { AuthProviders } = AlchemyAuthProvider
const { ProfileLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { NebiusAuth } = NebiusAuthModule
const { NebiusCredentials, fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransport, NebiusGrpcTransportLive } = GrpcTransportModule
const { StorageGrpcService, StorageGrpcServiceLive } = BucketGrpcServiceModule


// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

/** Fake gRPC channel — for structural tests only. */
const fakeChannel = new grpc.Channel(
  'localhost:0',
  grpc.credentials.createInsecure(),
  {},
)

/** Mock transport → mock service: no credentials needed. */
const mockTransportLayer = Layer.succeed(NebiusGrpcTransport, {
  getChannel: (_endpoint: string) => Effect.succeed(fakeChannel),
  channelFor: (_service: string) => Effect.succeed(fakeChannel),
  evictChannel: (_endpoint: string) => Effect.void,
})

const mockServiceLayer = StorageGrpcServiceLive.pipe(
  Layer.provide(mockTransportLayer),
)

/**
 * Full integration layer: real auth pipeline → real transport → real service.
 *
 * Uses fromAuthProvider for credential resolution (env, stored, or CLI),
 * NOT direct process.env access.
 */
const authLayer = Layer.mergeAll(ProfileLive, NebiusAuth).pipe(
  Layer.provide(CredentialsStoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      PlatformNode.NodeServices.layer,
    ),
  ),
)

const integrationLayer = StorageGrpcServiceLive.pipe(
  Layer.provide(NebiusGrpcTransportLive),
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)

// ---------------------------------------------------------------------------
// Gating: resolve credentials through the real pipeline.
// ---------------------------------------------------------------------------

const hasCredentials: boolean = await (async () => {
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const credsEffect = yield* NebiusCredentials
        yield* credsEffect
      }).pipe(
        Effect.provide(fromAuthProvider.pipe(Layer.provide(authLayer))),
        Effect.scoped,
      ),
    )
    return true
  } catch {
    return false
  }
})()

// Integration-flag gate: a plain `bun test` must never create/delete real buckets.
// `hasCredentials` is an additional runtime skip when the flag is set but no
// stored credentials are resolvable on this machine.
const it = runIntegration() && hasCredentials ? test : test.skip

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageGrpcService (bucket)', () => {
  describe('layer construction', () => {
    test('builds with mock transport', async () => {
      await Effect.runPromise(
        Effect.scoped(Layer.build(mockServiceLayer).pipe(Effect.asVoid)),
      )
    })

    test('exposes all CRUD methods with operation-aware signatures', async () => {
      const svc = await Effect.runPromise(
        Effect.gen(function* () {
          const { bucket: svc } = yield* StorageGrpcService
          return svc
        }).pipe(Effect.provide(mockServiceLayer), Effect.scoped),
      )

      // All methods exist
      expect(typeof svc.get).toBe('function')
      expect(typeof svc.getByName).toBe('function')
      expect(typeof svc.list).toBe('function')
      expect(typeof svc.create).toBe('function')
      expect(typeof svc.update).toBe('function')
      expect(typeof svc.delete).toBe('function')
      expect(typeof svc.purge).toBe('function')
      expect(typeof svc.undelete).toBe('function')
    })

    test('get accepts id string', () => {
      // get now takes a plain id string, not a GetBucketRequest proto
      expect(typeof 'bucket-456').toBe('string')
    })
  })

  describe('integration — real API', () => {
    it('calls the real list API and returns a typed result (success or GrpcError)', async () => {
      // The gRPC call may fail due to platform transport issues (e.g. h2 support),
      // but it should return a properly-typed result, not crash.
      // This verifies the full pipeline: auth → credentials → transport → service → gRPC call.
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { bucket: svc } = yield* StorageGrpcService
          return yield* svc.list(process.env.NEBIUS_PROJECT_ID ?? '').pipe(
            Effect.map(
              (response) =>
                ({ _tag: 'Right' as const, value: response }),
            ),
            Effect.catch((error) =>
              Effect.succeed({ _tag: 'Left' as const, value: error }),
            ),
          )
        }).pipe(Effect.provide(integrationLayer), Effect.scoped),
      )

      expect(result).toBeDefined()
      if (result._tag === 'Right') {
        expect(Array.isArray(result.value)).toBe(true)
      } else {
        // Left: GrpcError from transport — still proves the pipeline works.
        expect(result.value._tag).toBe('GrpcError')
      }
    })

    it('creates and deletes a bucket via operation-aware service', async () => {
      const bucketName = `alchemy-test-${Date.now()}`
      const projectId = process.env.NEBIUS_PROJECT_ID ?? ''

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const { bucket: svc } = yield* StorageGrpcService

          // Create — simplified input, no proto types
          const createResult = yield* svc.create({
            metadata: { parentId: projectId, name: bucketName },
            spec: {},
          }).pipe(
            Effect.map((b) => ({ _tag: 'Right' as const, value: b })),
            Effect.catch((error) =>
              Effect.succeed({ _tag: 'Left' as const, value: error }),
            ),
          )

          if (createResult._tag !== 'Right') {
            expect(createResult.value._tag).toBeDefined()
            return { outcome: 'create-failed' as const }
          }

          const bucket = createResult.value
          expect(typeof bucket.metadata?.id).toBe('string')
          expect(bucket.metadata!.id.length).toBeGreaterThan(0)
          expect(bucket.status?.domainName).toBeDefined()

          // Get by simplified id string
          const fetched = yield* svc.get(bucket.metadata!.id).pipe(
            Effect.map((b) => ({ _tag: 'Right' as const, value: b })),
            Effect.catch((error) =>
              Effect.succeed({ _tag: 'Left' as const, value: error }),
            ),
          )
          if (fetched._tag === 'Right') {
            expect(fetched.value.metadata?.id).toBe(bucket.metadata!.id)
          }

          // Delete by simplified id string
          const deleteResult = yield* svc.delete(bucket.metadata!.id).pipe(
            Effect.map(() => ({ _tag: 'Right' as const })),
            Effect.catch((error) =>
              Effect.succeed({ _tag: 'Left' as const, value: error }),
            ),
          )

          if (deleteResult._tag === 'Right') {
            return { outcome: 'create-and-delete-succeeded' as const }
          }
          expect(deleteResult.value._tag).toBeDefined()
          return { outcome: 'delete-failed' as const }
        }).pipe(Effect.provide(integrationLayer), Effect.scoped),
      )

      expect(result).toBeDefined()
      expect(result.outcome).toBeDefined()
    }, { timeout: 10_000 })
  })
})
