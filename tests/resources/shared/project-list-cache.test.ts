/**
 * R-12 — the tenant's project list is fetched **once**, not once per resource family.
 *
 * The fan-out is `alchemy unsafe nuke`'s enumeration: it runs every provider's `list` in one process,
 * and each of them starts by enumerating the tenant's projects. Before this the project list was one
 * identical RPC per family (`41 × (1 + M)` requests, of which the `41` are pure duplication), and the
 * per-project enumerations were sequential.
 *
 * These tests use `makeTenantScopedList` — the lifecycle 30 providers share — over a *counting* IAM
 * mock, so "fetched once" is an assertion about the request count, not about a cache object existing.
 */
import { describe, expect, test } from 'bun:test'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'

import type { GrpcError, GrpcDeadlineExceededError } from '../../../modules/api-client/grpc-utils.ts'
import { GrpcError as GrpcErrorCtor } from '../../../modules/api-client/grpc-utils.ts'
import * as IamGrpc from '../../../modules/api-client/iam.ts'
import { makeTenantScopedList } from '../../../modules/resources/factory.ts'
import { IamGrpcServiceWithProjectListCache } from '../../../modules/resources/shared/project-list-cache.ts'
import { mockIamLayer, testConfigLayer } from '../../helpers/mocks.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `Effect.fn` with generic service tags captures context as `any` when the requirements include
 * `ConfigProvider.ConfigProvider`. This helper bridges the gap for `Effect.runPromise`, which expects
 * `R = never` (the same workaround `factory.test.ts` documents).
 */
const runPromise = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E>)

interface TestResource {
  metadata: { id: string; name: string; labels: Record<string, string> }
}

interface TestListService {
  list: (parentId: string) => Effect.Effect<ReadonlyArray<TestResource>, GrpcError | GrpcDeadlineExceededError>
}

interface TestAttrs {
  id: string
  name: string
}

/** Two distinct resource types, so "shared across resource types" is more than a claim. */
class NetworkSvc extends Context.Service<NetworkSvc, TestListService>()('TestCacheNetworkSvc') {}
class DiskSvc extends Context.Service<DiskSvc, TestListService>()('TestCacheDiskSvc') {}

/** A raw resource that survives `isDefaultResource` (an `alchemy::` label means "not a default"). */
const resource = (id: string): TestResource => ({
  metadata: { id, name: id, labels: { 'alchemy::id': id } },
})

const toAttrs = (r: TestResource): TestAttrs => ({ id: r.metadata.id, name: r.metadata.name })

const networksList = makeTenantScopedList({
  resourceName: 'TestNetworks',
  service: NetworkSvc,
  iamService: IamGrpc.IamGrpcService,
  projectList: (iam, tenantId) => iam.project.list(tenantId),
  projectId: (project) => project.metadata!.id,
  listByParent: (svc, parentId) => svc.list(parentId),
  toAttrs,
})

const disksList = makeTenantScopedList({
  resourceName: 'TestDisks',
  service: DiskSvc,
  iamService: IamGrpc.IamGrpcService,
  projectList: (iam, tenantId) => iam.project.list(tenantId),
  projectId: (project) => project.metadata!.id,
  listByParent: (svc, parentId) => svc.list(parentId),
  toAttrs,
})

/** One project's rows, for one fake resource type. */
const listOf = (rows: ReadonlyArray<TestResource>): TestListService => ({
  list: (parentId: string) => Effect.succeed(parentId === 'project-1' ? [...rows] : []),
})

const networkRows = (rows: ReadonlyArray<TestResource>) => Layer.succeed(NetworkSvc, NetworkSvc.of(listOf(rows)))
const diskRows = (rows: ReadonlyArray<TestResource>) => Layer.succeed(DiskSvc, DiskSvc.of(listOf(rows)))

/** An IAM mock whose `project.list` records every tenant it was asked for. */
const countingIam = (calls: Array<string>, projects: ReadonlyArray<{ metadata: { id: string } }>) =>
  mockIamLayer({
    project: {
      list: (tenantId: string) => {
        calls.push(tenantId)
        return Effect.succeed(projects)
      },
    },
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('project list memoization', () => {
  test('two resource types listing at once share ONE project list fetch', async () => {
    const calls: Array<string> = []
    const layer = Layer.mergeAll(
      IamGrpcServiceWithProjectListCache.pipe(Layer.provide(countingIam(calls, [{ metadata: { id: 'project-1' } }]))),
      testConfigLayer,
      networkRows([resource('network-1')]),
      diskRows([resource('disk-1')]),
    )

    const [networks, disks] = await runPromise(
      Effect.all([networksList(), disksList()], { concurrency: 'unbounded' }).pipe(Effect.provide(layer)),
    )

    // One RPC for two families — and concurrently, so the second caller either shared the in-flight
    // lookup or read the cached result; either way it did not issue its own request.
    expect(calls).toEqual(['tenant-test-1'])
    expect(networks.map((n) => n.id)).toEqual(['network-1'])
    expect(disks.map((d) => d.id)).toEqual(['disk-1'])
  })

  test('the entry survives the first call — a later family still reuses it', async () => {
    const calls: Array<string> = []
    const layer = Layer.mergeAll(
      IamGrpcServiceWithProjectListCache.pipe(Layer.provide(countingIam(calls, [{ metadata: { id: 'project-1' } }]))),
      testConfigLayer,
      networkRows([resource('network-1')]),
      diskRows([resource('disk-1')]),
    )

    const program = Effect.gen(function* () {
      const first = yield* networksList()
      const second = yield* disksList()
      return [first.length, second.length] as const
    })

    expect(await runPromise(program.pipe(Effect.provide(layer)))).toEqual([1, 1])
    expect(calls).toEqual(['tenant-test-1'])
  })

  test('a FAILED project list is not cached — the next caller re-fetches', async () => {
    const calls: Array<string> = []
    let attempt = 0
    const iam = mockIamLayer({
      project: {
        list: (tenantId: string) => {
          calls.push(tenantId)
          attempt += 1
          return attempt === 1
            ? Effect.fail(new GrpcErrorCtor({ code: 14, message: 'UNAVAILABLE', details: '' }))
            : Effect.succeed([{ metadata: { id: 'project-1' } }])
        },
      },
    })
    const layer = Layer.mergeAll(
      IamGrpcServiceWithProjectListCache.pipe(Layer.provide(iam)),
      testConfigLayer,
      networkRows([resource('network-1')]),
    )

    const program = Effect.gen(function* () {
      // A transient failure must not poison the whole nuke with one cached error.
      const failed = yield* Effect.exit(networksList())
      const recovered = yield* networksList()
      return [failed._tag, recovered.length] as const
    })

    expect(await runPromise(program.pipe(Effect.provide(layer)))).toEqual(['Failure', 1])
    expect(calls).toEqual(['tenant-test-1', 'tenant-test-1'])
  })

  test('only `project.list` is memoized — every other member is the raw service', async () => {
    const rawStaticKeyList = (_parentId: string) => Effect.succeed([])
    const layer = IamGrpcServiceWithProjectListCache.pipe(
      Layer.provide(
        mockIamLayer({
          project: { list: () => Effect.succeed([{ metadata: { id: 'project-1' } }]) },
          staticKey: { list: rawStaticKeyList },
        }),
      ),
    )

    const sameReference = await Effect.runPromise(
      Effect.gen(function* () {
        const iam = yield* IamGrpc.IamGrpcService
        return iam.staticKey.list === rawStaticKeyList
      }).pipe(Effect.provide(layer)),
    )

    expect(sameReference).toBe(true)
  })
})

/**
 * The single-flight half, pinned against the layer directly rather than through a `list` lifecycle.
 *
 * Two callers read the same tenant concurrently while the lookup is deliberately slow — it parks on a
 * `Deferred` the test owns — so whichever way they interleave, exactly one request is issued: a second
 * caller arriving before the lookup answers joins the pending fiber, and one arriving after reads the
 * cached result. The gate only guarantees the lookup is not instantaneous; the assertion is on the
 * request count.
 */
describe('project list single-flight', () => {
  test('two concurrent reads of the same tenant issue one request', async () => {
    let calls = 0
    const program = Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const iam = mockIamLayer({
        project: {
          list: () =>
            Effect.suspend(() => {
              calls += 1
              return Effect.andThen(Deferred.await(gate), Effect.succeed([{ metadata: { id: 'project-1' } }]))
            }),
        },
      })
      const cachedIam = IamGrpcServiceWithProjectListCache.pipe(Layer.provide(iam))

      const both = yield* Effect.gen(function* () {
        const cached = yield* IamGrpc.IamGrpcService
        return yield* Effect.all([cached.project.list('tenant-test-1'), cached.project.list('tenant-test-1')], {
          concurrency: 'unbounded',
        })
      }).pipe(Effect.provide(cachedIam), Effect.forkChild)

      yield* Deferred.succeed(gate, undefined)
      return yield* Fiber.join(both)
    })

    const [first, second] = await Effect.runPromise(program)
    expect(calls).toBe(1)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })
})
