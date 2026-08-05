import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as NebiusAuthModule from '../../modules/AuthProvider'
import * as NebiusCredentialsModule from '../../modules/Credentials'
import * as GrpcTransportModule from '../../modules/api-client/GrpcTransport.ts'
import * as EndpointsModule from '../../modules/endpoints.ts'
import { runIntegration } from '../helpers/gate'

const { describe, expect, test } = BunTest
const { UnknownServiceError } = EndpointsModule
const { AuthProviders } = AlchemyAuthProvider
const { ProfileLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { NebiusAuth } = NebiusAuthModule
const { NebiusCredentials, fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransport, NebiusGrpcTransportLive } = GrpcTransportModule

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

/**
 * Structural mock: provides a fake API-key credential so the layer can build
 * without touching real auth. The gRPC channel is created but won't connect.
 */
const mockLayer = NebiusGrpcTransportLive.pipe(
  Layer.provide(
    Layer.succeed(
      NebiusCredentials,
      Effect.succeed({ apiKey: Redacted.make('fake-test-key') }),
    ),
  ),
)

/**
 * Full integration layer: uses the real auth pipeline (fromAuthProvider) to
 * resolve Nebius credentials, then creates a live gRPC channel.
 *
 * Layer dependency graph (bottom-up):
 *   PlatformNode.NodeServices → FileSystem, ChildProcessSpawner
 *   ConfigProvider → env vars (ALCHEMY_PROFILE, NEBIUS_API_KEY, CI)
 *   CredentialsStoreLive → CredentialsStore (needs FileSystem)
 *   ProfileLive → AlchemyProfile (needs CredentialsStore, FileSystem, ConfigProvider)
 *   NebiusAuth → registers "Nebius" in AuthProviders (needs CredentialsStore, ChildProcessSpawner)
 *   fromAuthProvider → NebiusCredentials (needs Profile, Auth, ConfigProvider)
 *   NebiusGrpcTransportLive → NebiusGrpcTransport (needs NebiusCredentials + Scope)
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

const integrationLayer = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)

// ---------------------------------------------------------------------------
// Gating: resolve credentials through the real pipeline to decide whether
// integration tests should run.
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

// Integration-flag gate: a plain `bun test` must never open real gRPC channels.
// `hasCredentials` is an additional runtime skip when the flag is set but no
// stored credentials are resolvable on this machine.
const it = runIntegration() && hasCredentials ? test : test.skip

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NebiusGrpcTransport', () => {
  describe('layer construction', () => {
    test('builds with mock credentials', async () => {
      await Effect.runPromise(
        Effect.scoped(Layer.build(mockLayer).pipe(Effect.asVoid)),
      )
    })

    test('exposes getChannel and channelFor', async () => {
      const transport = await Effect.runPromise(
        NebiusGrpcTransport.pipe(Effect.provide(mockLayer), Effect.scoped),
      )

      expect(typeof transport.getChannel).toBe('function')
      expect(typeof transport.channelFor).toBe('function')
      expect(typeof transport.evictChannel).toBe('function')
    })

    test('channelFor resolves endpoint from NebiusConfig', async () => {
      const channel = await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* NebiusGrpcTransport
          return yield* transport.channelFor('nebius.storage.v1.BucketService')
        }).pipe(Effect.provide(mockLayer), Effect.scoped),
      )

      expect(channel).toBeDefined()
      expect(channel.getConnectivityState(false)).toBeDefined()
    })

    test('getChannel creates channel for custom endpoint', async () => {
      const channel = await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* NebiusGrpcTransport
          return yield* transport.getChannel('custom.example.com:443')
        }).pipe(Effect.provide(mockLayer), Effect.scoped),
      )

      expect(channel).toBeDefined()
      expect(channel.getConnectivityState(false)).toBeDefined()
    })

    test('reuses channel for same endpoint', async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* NebiusGrpcTransport
          const a = yield* transport.getChannel('reuse.test:443')
          const b = yield* transport.getChannel('reuse.test:443')
          expect(a).toBe(b) // same object — channel reuse
        }).pipe(Effect.provide(mockLayer), Effect.scoped),
      )
    })

    test('creates distinct channels for different endpoints', async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* NebiusGrpcTransport
          const a = yield* transport.getChannel('a.example.com:443')
          const b = yield* transport.getChannel('b.example.com:443')
          expect(a).not.toBe(b)
        }).pipe(Effect.provide(mockLayer), Effect.scoped),
      )
    })

    test('evictChannel removes cached channel so next getChannel creates a new one', async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* NebiusGrpcTransport
          const a = yield* transport.getChannel('evict.test:443')
          yield* transport.evictChannel('evict.test:443')
          const b = yield* transport.getChannel('evict.test:443')
          expect(a).not.toBe(b) // different objects — channel was rebuilt
        }).pipe(Effect.provide(mockLayer), Effect.scoped),
      )
    })

    test('channelFor fails with UnknownServiceError for unknown service', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* NebiusGrpcTransport
          return yield* transport.channelFor('nebius.nonexistent.v1.FakeService')
        }).pipe(
          Effect.provide(mockLayer),
          Effect.scoped,
          Effect.flip,
        ),
      )

      expect(result).toBeInstanceOf(UnknownServiceError)
      expect((result as any).service).toBe('nebius.nonexistent.v1.FakeService')
    })
  })

  describe('integration — real API', () => {
    it('channelFor resolves BucketService endpoint from NebiusConfig', async () => {
      const channel = await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* NebiusGrpcTransport
          return yield* transport.channelFor('nebius.storage.v1.BucketService')
        }).pipe(Effect.provide(integrationLayer), Effect.scoped),
      )

      expect(channel).toBeDefined()

      // Channel state is platform-dependent (h2 support varies).
      // Just verify it returns a valid state number.
      const state = channel.getConnectivityState(true)
      expect(typeof state).toBe('number')
    })

    it('channelFor resolves TransferService to a different endpoint than BucketService', async () => {
      const [bucketChannel, transferChannel] = await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* NebiusGrpcTransport
          const bc = yield* transport.channelFor('nebius.storage.v1.BucketService')
          const tc = yield* transport.channelFor('nebius.storage.v1.TransferService')
          return [bc, tc] as const
        }).pipe(Effect.provide(integrationLayer), Effect.scoped),
      )

      expect(bucketChannel).toBeDefined()
      expect(transferChannel).toBeDefined()
      // TransferService is on a different endpoint, so channels should differ
      expect(bucketChannel).not.toBe(transferChannel)
    })
  })
})
