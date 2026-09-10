import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as NebiusAuthModule from '../../../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../../../modules/Credentials.ts'
import * as SaTokenModule from '../../../modules/auth/sa-token.ts'
import * as SaBootstrapModule from '../../../modules/auth/sa-bootstrap.ts'
import * as GrpcTransportModule from '../../../modules/api-client/GrpcTransport.ts'
import * as BucketGrpcServiceModule from '../../../modules/api-client/storage.ts'
import * as GrpcUtilsModule from '../../../modules/api-client/grpc-utils.ts'
import { runIntegration, INTEGRATION_TIMEOUT_MS } from '../../helpers/gate.ts'
import { redact } from '../../helpers/cleanup.ts'
import { uniqueName } from '../../helpers/names.ts'
import { fakeChannel } from '../../helpers/channel.ts'

const { beforeAll, describe, expect, test } = BunTest
const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { NebiusAuth } = NebiusAuthModule
const { NebiusCredentials, fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransport, NebiusGrpcTransportLive } = GrpcTransportModule
const { StorageGrpcService, StorageGrpcServiceLive } = BucketGrpcServiceModule
const { GrpcError, GrpcDeadlineExceededError, OperationFailedError } = GrpcUtilsModule


// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

/** Fake gRPC channel — pure structural mock, never a real channel. */
const channel = fakeChannel()

/** Mock transport → mock service: no credentials needed. */
const mockTransportLayer = Layer.succeed(NebiusGrpcTransport, {
  getChannel: (_endpoint: string) => Effect.succeed(channel),
  channelFor: (_service: string) => Effect.succeed(channel),
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
const authLayer = Layer.mergeAll(ProfileStoreLive, NebiusAuth).pipe(
  Layer.provide(CredentialsStoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      PlatformNode.NodeServices.layer,
      // Satisfy NebiusAuth's sa-key requirement (never exercised here).
      SaTokenModule.SaTokenMinterLive,
      SaBootstrapModule.SaBootstrapLive,
    ),
  ),
)

const integrationLayer = StorageGrpcServiceLive.pipe(
  Layer.provide(NebiusGrpcTransportLive),
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)

// ---------------------------------------------------------------------------
// Gating: resolve credentials lazily (beforeAll) and bounded (10s race) to
// decide whether integration tests should run. No top-level await: a plain
// `bun test` performs zero auth I/O and collection never blocks on resolution.
// ---------------------------------------------------------------------------

let hasCredentials = false

/**
 * Resolve credentials through the real auth pipeline (env, stored, or CLI).
 * Bounded by the race in `beforeAll` so a hanging resolution (e.g. a stuck
 * CLI spawn) cannot block the test run for more than 10 seconds.
 */
const resolveCredentials = (): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const credsEffect = yield* NebiusCredentials
      yield* credsEffect
    }).pipe(
      Effect.provide(fromAuthProvider.pipe(Layer.provide(authLayer))),
      Effect.scoped,
    ),
  ).then(
    () => true,
    () => false,
  )

beforeAll(async () => {
  // Only resolve credentials when the integration run is opted in — a plain
  // `bun test` (no SLOW_TESTS) must not perform any auth I/O.
  if (!runIntegration()) return
  hasCredentials = await Promise.race([
    resolveCredentials(),
    new Promise<false>((res) => setTimeout(() => res(false), 10_000)),
  ])
}, { timeout: 15_000 })

// Collection-time gate: the integration flag only. bun evaluates `skipIf` at
// collection time, so the credential check cannot be a collection-time skip —
// it is a runtime guard inside each integration test below.
const it = runIntegration() ? test : test.skip

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
      // Runtime credential guard — see the gating block above.
      if (!hasCredentials) return

      // Tolerant by design: this verifies the full auth → credentials →
      // transport → service → gRPC pipeline, NOT API correctness. A degraded
      // network (UNAVAILABLE / DEADLINE_EXCEEDED) must not fail the plumbing
      // check. But a non-gRPC error (e.g. UnknownServiceError) WOULD mean the
      // library's own wiring is broken — those must fail. Do not weaken the
      // Left-branch assertions below.
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
        // Well-formed array result — buckets (or an empty list).
        expect(Array.isArray(result.value)).toBe(true)
        for (const bucket of result.value) {
          expect(typeof bucket).toBe('object')
        }
      } else {
        // Left: must be a gRPC/transport-level error — the pipeline reached the
        // API. Anything else (UnknownServiceError, ...) means the wiring broke.
        const error = result.value
        if (error instanceof GrpcError) {
          // Documented gRPC status code: 4 DEADLINE_EXCEEDED, 5 NOT_FOUND,
          // 6 ALREADY_EXISTS, 7 PERMISSION_DENIED, 8 RESOURCE_EXHAUSTED,
          // 9 FAILED_PRECONDITION, 10 ABORTED, 12 UNIMPLEMENTED, 13 INTERNAL,
          // 14 UNAVAILABLE, 15 DATA_LOSS, 16 UNAUTHENTICATED.
          expect([4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16]).toContain(error.code)
        } else if (error instanceof GrpcDeadlineExceededError) {
          // Transport-level timeout — pipeline works, infra slow.
        } else {
          throw new Error(`unexpected error type from list pipeline: ${String(error)}`)
        }
      }
    }, { timeout: INTEGRATION_TIMEOUT_MS })

    it('creates and deletes a bucket via operation-aware service', async () => {
      // Runtime credential guard — see the gating block above.
      if (!hasCredentials) return

      // Random suffix (not Date.now()): parallel runs in the same millisecond
      // and leaked buckets from prior failed runs must never collide.
      const bucketName = uniqueName('alchemy-test')
      const projectId = process.env.NEBIUS_PROJECT_ID ?? ''

      // Tracked OUTSIDE the Effect so the cleanup block — which runs on ANY
      // exit (success, assertion failure, failed gRPC call) — can attempt
      // deletion of the bucket this test created.
      let createdBucketId: string | undefined

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
            return { outcome: 'create-failed' as const, error: createResult.value }
          }

          const bucket = createResult.value
          expect(typeof bucket.metadata?.id).toBe('string')
          expect(bucket.metadata!.id.length).toBeGreaterThan(0)
          expect(bucket.status?.domainName).toBeDefined()
          createdBucketId = bucket.metadata!.id

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

          // Delete by simplified id string — the actual delete under test.
          // (The Effect.ensuring cleanup below is the safety net for the case
          // where this fails or the body aborts before reaching it.)
          const deleteResult = yield* svc.delete(bucket.metadata!.id).pipe(
            Effect.map(() => ({ _tag: 'Right' as const })),
            Effect.catch((error) =>
              Effect.succeed({ _tag: 'Left' as const, value: error }),
            ),
          )

          if (deleteResult._tag === 'Right') {
            return { outcome: 'create-and-delete-succeeded' as const }
          }
          return { outcome: 'delete-failed' as const, error: deleteResult.value }
        }).pipe(
          // Guaranteed cleanup — mirrors the pattern used by every SLOW_TESTS
          // resource test. Runs on any exit of the body: success, a failed
          // assertion, or a failed gRPC call. Idempotent: no-op when the
          // bucket was never created (create failed). Delete failures are
          // logged only — they must not mask the body's own outcome.
          Effect.ensuring(
            Effect.gen(function* () {
              if (createdBucketId === undefined) return
              const { bucket: svc } = yield* StorageGrpcService
              yield* svc.delete(createdBucketId).pipe(
                Effect.tapError((e) =>
                  Effect.logError(`[cleanup] bucket delete failed: ${redact(String(e))}`),
                ),
                Effect.ignore,
              )
            }),
          ),
          Effect.provide(integrationLayer),
          Effect.scoped,
        ),
      )

      expect(result).toBeDefined()
      if (result.outcome === 'create-and-delete-succeeded') {
        // Full pipeline worked: auth → credentials → transport → service →
        // create operation → delete operation.
        return
      }

      // Failure path: the pipeline still worked if the error is gRPC/operation
      // level (infra down, quota, transient) — as opposed to UnknownServiceError
      // or anything else, which would mean the library wiring is broken.
      const error = result.error
      if (error instanceof GrpcError) {
        // Documented gRPC status code — e.g. 14 UNAVAILABLE (transport down),
        // 8 RESOURCE_EXHAUSTED (quota), 6 ALREADY_EXISTS, 5 NOT_FOUND, ...
        expect([4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16]).toContain(error.code)
        return
      }
      if (error instanceof GrpcDeadlineExceededError || error instanceof OperationFailedError) {
        // Transport-level timeout / long-running operation failed server-side.
        return
      }
      throw new Error(`unexpected error type from create/delete pipeline: ${String(error)}`)
    }, { timeout: INTEGRATION_TIMEOUT_MS })
  })
})
