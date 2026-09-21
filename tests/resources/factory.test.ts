import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Context from 'effect/Context'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Duration from 'effect/Duration'
import * as Layer from 'effect/Layer'

import type { GrpcError, GrpcDeadlineExceededError } from '../../modules/api-client/grpc-utils.ts'
import { GrpcError as GrpcErrorCtor } from '../../modules/api-client/grpc-utils.ts'
import {
  identityChangeRequiresReplace,
  makeCrudDelete,
  makeTenantScopedList,
  runDeleteWithProgress,
} from '../../modules/resources/factory.ts'
import { fakeSession } from '../helpers/mocks.ts'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Effect.fn with generic service tags captures context as `any` when the
 * requirements include `ConfigProvider.ConfigProvider`. This helper bridges
 * the gap for `Effect.runPromise` which expects `R = never`.
 */
const runPromise = <A, E>(
  effect: Effect.Effect<A, E, any>,
): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, E>)

class TestSvc extends Context.Service<TestSvc, {
  list: (parentId: string) => Effect.Effect<ReadonlyArray<TestResource>, GrpcError | GrpcDeadlineExceededError>
}>()('TestSvc') {}

class TestIam extends Context.Service<TestIam, {
  project: { list: (tenantId: string) => Effect.Effect<ReadonlyArray<TestProject>, GrpcError | GrpcDeadlineExceededError> }
}>()('TestIam') {}

interface TestResource {
  metadata: { id: string; name: string; labels: Record<string, string> }
  /** Only `status.default` is read, and only to detect platform-provisioned resources. */
  status?: { default?: boolean }
  spec: { description: string }
}

interface TestProject {
  metadata: { id: string; name: string }
}

interface TestAttrs {
  id: string
  name: string
  state: string
}

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeTestIam = (projects: TestProject[]) =>
  Layer.succeed(TestIam, TestIam.of({
    project: {
      list: (_tenantId: string) => Effect.succeed(projects),
    },
  }))

const makeTestSvc = (resourcesByProject: Map<string, TestResource[]>) =>
  Layer.succeed(TestSvc, TestSvc.of({
    list: (parentId: string) =>
      Effect.succeed(resourcesByProject.get(parentId) ?? []),
  }))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isDefaultResource filtering', () => {
  const tenantScopedList = makeTenantScopedList({
    resourceName: 'TestResource',
    service: TestSvc,
    iamService: TestIam,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata.id,
    listByParent: (svc, parentId) => svc.list(parentId),
    toAttrs: (r: TestResource): TestAttrs => ({
      id: r.metadata.name,
      name: r.metadata.name,
      state: 'READY',
    }),
  })

  test('excludes resources with default- name prefix', async () => {
    const projects: TestProject[] = [
      { metadata: { id: 'proj-1', name: 'my-project' } },
    ]
    const resources = new Map<string, TestResource[]>([
      ['proj-1', [
        { metadata: { id: 'res-default-net', name: 'default-network', labels: {} }, spec: { description: '' } },
        { metadata: { id: 'res-my-net', name: 'my-network', labels: { 'alchemy::id': 'my-net' } }, spec: { description: '' } },
        { metadata: { id: 'res-default-subnet', name: 'default-subnet-abc', labels: {} }, spec: { description: '' } },
      ]],
    ])

    const layer = Layer.mergeAll(
      makeTestIam(projects),
      makeTestSvc(resources),
    ).pipe(
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_TENANT_ID: 'tenant-1' }))),
    )

    const result = await runPromise(
      tenantScopedList().pipe(Effect.provide(layer)),
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('my-network')
  })

  /** Run the tenant-scoped list over one project's resources. */
  const listWith = (resources: ReadonlyArray<TestResource>) =>
    runPromise(
      tenantScopedList().pipe(
        Effect.provide(
          Layer.mergeAll(
            makeTestIam([{ metadata: { id: 'proj-1', name: 'my-project' } }]),
            makeTestSvc(new Map([['proj-1', [...resources]]])),
          ).pipe(
            Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_TENANT_ID: 'tenant-1' }))),
          ),
        ),
      ),
    )

  test('each default signal is sufficient on its own', async () => {
    // Every resource that must be filtered below carries **non-empty, non-Alchemy**
    // labels, so the name/known-name/status rules are the only reason it is excluded.
    // With empty labels they would be filtered by the "no labels ⇒ system resource"
    // rule anyway — which is exactly how these branches went unobserved: mutating
    // `name?.startsWith('default-')` seven ways all survived the `bun run mutation`
    // baseline (2026-09-21), and the `status.default` case had an empty test body.
    const owned = { owner: 'platform' }
    const result = await listWith([
      { metadata: { id: 'r-prefix', name: 'default-network', labels: owned }, spec: { description: '' } },
      { metadata: { id: 'r-known', name: 'mlflow-sa', labels: owned }, spec: { description: '' } },
      {
        metadata: { id: 'r-status', name: 'external-thing', labels: owned },
        status: { default: true },
        spec: { description: '' },
      },
      { metadata: { id: 'r-nolabels', name: 'unlabelled-thing', labels: {} }, spec: { description: '' } },
      // Kept: Alchemy-owned, and a third-party-labelled resource that is not a default.
      { metadata: { id: 'r-ours', name: 'my-network', labels: { 'alchemy::id': 'my-network' } }, spec: { description: '' } },
      { metadata: { id: 'r-team', name: 'team-network', labels: { team: 'sre' } }, spec: { description: '' } },
    ])

    expect(result.map((r) => r.name).toSorted()).toEqual(['my-network', 'team-network'])
  })

  test('a record with no metadata is a system default, not a crash', async () => {
    // A sparse API response must not throw: `isDefaultResource` reads
    // `metadata?.labels` / `metadata?.name`, and an object with neither is a
    // system-provisioned default — filtered before `toAttrs` ever runs.
    const result = await listWith([{} as unknown as TestResource])

    expect(result).toHaveLength(0)
  })

  test('returns empty array when all resources are defaults', async () => {
    const projects: TestProject[] = [
      { metadata: { id: 'proj-1', name: 'my-project' } },
    ]
    const resources = new Map<string, TestResource[]>([
      ['proj-1', [
        { metadata: { id: 'res-default-net-2', name: 'default-network', labels: {} }, spec: { description: '' } },
        { metadata: { id: 'res-default-sg', name: 'default-security-group-xyz', labels: {} }, spec: { description: '' } },
      ]],
    ])

    const layer = Layer.mergeAll(
      makeTestIam(projects),
      makeTestSvc(resources),
    ).pipe(
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_TENANT_ID: 'tenant-1' }))),
    )

    const result = await runPromise(
      tenantScopedList().pipe(Effect.provide(layer)),
    )

    expect(result).toHaveLength(0)
  })

  test('resources with alchemy labels are never filtered as defaults', async () => {
    const projects: TestProject[] = [
      { metadata: { id: 'proj-1', name: 'my-project' } },
    ]
    const resources = new Map<string, TestResource[]>([
      ['proj-1', [
        // Has alchemy labels — survives even though name matches DEFAULT_RESOURCE_NAMES
        { metadata: { id: 'sa-alchemy', name: 'mlflow-sa', labels: { 'alchemy::id': 'sa-1', 'alchemy::stack': 'prod' } }, spec: { description: '' } },
        // No alchemy labels — filtered by empty labels, regardless of name
        { metadata: { id: 'sa-no-labels', name: 'mlflow-sa', labels: {} }, spec: { description: '' } },
      ]],
    ])

    const layer = Layer.mergeAll(
      makeTestIam(projects),
      makeTestSvc(resources),
    ).pipe(
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_TENANT_ID: 'tenant-1' }))),
    )

    const result = await runPromise(
      tenantScopedList().pipe(Effect.provide(layer)),
    )

    // Only the Alchemy-tagged mlflow-sa survives
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('mlflow-sa')
  })

  test('handles per-project errors gracefully', async () => {
    class FailingSvc extends Context.Service<FailingSvc, {
      list: (parentId: string) => Effect.Effect<ReadonlyArray<TestResource>, GrpcError>
    }>()('FailingSvc') {}

    const failingList = makeTenantScopedList({
      resourceName: 'FailingResource',
      service: FailingSvc,
      iamService: TestIam,
      projectList: (iam, tenantId) => iam.project.list(tenantId),
      projectId: (p) => p.metadata.id,
      listByParent: (svc, parentId) => svc.list(parentId),
      toAttrs: (r: TestResource): TestAttrs => ({
        id: r.metadata.name,
        name: r.metadata.name,
        state: 'READY',
      }),
    })

    const projects: TestProject[] = [
      { metadata: { id: 'proj-ok', name: 'ok-project' } },
      { metadata: { id: 'proj-fail', name: 'failing-project' } },
    ]

    const failingSvcLayer = Layer.succeed(FailingSvc, FailingSvc.of({
      list: (parentId: string) =>
        parentId === 'proj-fail'
          ? Effect.fail(new GrpcErrorCtor({ code: 7, message: 'permission denied', details: '' }))
          : Effect.succeed([{ metadata: { id: 'res-ok', name: 'my-resource', labels: { 'alchemy::id': 'res-ok' } }, spec: { description: '' } }]),
    }))

    const layer = Layer.mergeAll(
      makeTestIam(projects),
      failingSvcLayer,
    ).pipe(
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_TENANT_ID: 'tenant-1' }))),
    )

    const result = await runPromise(
      failingList().pipe(Effect.provide(layer)),
    )

    // Resources from proj-ok should still be returned
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('my-resource')
  })
})

// ---------------------------------------------------------------------------
// makeCrudDelete — stalled-operation handling
// ---------------------------------------------------------------------------

/**
 * A delete operation can sit pending indefinitely server-side (measured: 28
 * minutes on a VPC subnet) while an *identical* re-issue completes in ~1s. The
 * factory therefore bounds each attempt and re-issues it, once per attempt,
 * instead of polling forever — and fails loudly if that never converges.
 */
describe('makeCrudDelete', () => {
  class DeleteSvc extends Context.Service<
    DeleteSvc,
    { delete: (id: string) => Effect.Effect<void, GrpcError | GrpcDeadlineExceededError> }
  >()('DeleteSvc') {}

  const STALL = Duration.millis(20)

  const deleteEffect = (
    deleteImpl: (id: string) => Effect.Effect<void, GrpcError | GrpcDeadlineExceededError>,
  ) => {
    const lifecycle = makeCrudDelete({
      resourceName: 'Test.Resource',
      resourceLabel: 'TestResource',
      service: DeleteSvc,
      deleteById: (svc, id) => svc.delete(id),
      stallAfter: STALL,
    })
    return lifecycle({ output: { id: 'res-1' }, session: fakeSession }).pipe(
      Effect.provide(Layer.succeed(DeleteSvc, DeleteSvc.of({ delete: deleteImpl }))),
    )
  }

  test('re-issues a stalled delete and succeeds on the next attempt', async () => {
    let calls = 0
    await runPromise(
      // Counted at RUN time (`flatMap`), not when the effect is built — the
      // factory builds the delete effect once and runs it per attempt.
      deleteEffect(() =>
        Effect.flatMap(
          Effect.sync(() => {
            calls += 1
            return calls
          }),
          (n) => (n === 1 ? Effect.never : Effect.void),
        ),
      ),
    )

    expect(calls).toBe(2)
  })

  test('fails loudly with DeleteStalledError when every attempt stalls', async () => {
    let calls = 0
    const error = (await runPromise(
      Effect.flip(
        deleteEffect(() =>
          Effect.flatMap(
            Effect.sync(() => {
              calls += 1
            }),
            () => Effect.never,
          ),
        ),
      ),
    )) as { _tag: string; message: string }

    expect(error._tag).toBe('DeleteStalledError')
    expect(calls).toBe(3)
    expect(error.message).toContain('never completed')
    // The message must give the operator something to do, not just a status.
    expect(error.message).toContain('re-running the destroy usually settles it')
  })

  test('a real failure fails on the first attempt (never re-issued)', async () => {
    let calls = 0
    const error = (await runPromise(
      Effect.flip(
        deleteEffect(() =>
          Effect.flatMap(
            Effect.sync(() => {
              calls += 1
            }),
            () => Effect.fail(new GrpcErrorCtor({ code: 7, message: 'permission denied', details: '' })),
          ),
        ),
      ),
    )) as { _tag: string }

    expect(calls).toBe(1)
    expect(error._tag).toBe('GrpcError')
  })

  test('NOT_FOUND is success — a server-side cascade already removed it', async () => {
    let calls = 0
    await runPromise(
      deleteEffect(() =>
        Effect.flatMap(
          Effect.sync(() => {
            calls += 1
          }),
          () => Effect.fail(new GrpcErrorCtor({ code: 5, message: 'not found', details: '' })),
        ),
      ),
    )

    expect(calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// runDeleteWithProgress — the API blocking a delete on a live dependency
// ---------------------------------------------------------------------------

/**
 * `9 FAILED_PRECONDITION` on a delete means "a dependent still exists", which is
 * routine mid-destroy: a VM tears down for minutes after its own delete returned,
 * and the subnet it held cannot go until it has. Verified live: the hosted test's
 * subnet/network were un-deletable while the instance/endpoint were still going,
 * and deleted in ~2.6s once they were gone.
 */
describe('runDeleteWithProgress — dependency still exists', () => {
  const preconditionFailure = () =>
    new GrpcErrorCtor({ code: 9, message: 'if subnets exist', details: '' })

  const runEffect = (deleteOnce: Effect.Effect<void, GrpcError>) =>
    runDeleteWithProgress({
      label: 'Test.Network',
      id: 'net-1',
      deleteOnce,
      session: fakeSession,
      dependentRetryDelay: Duration.millis(5),
    })

  const counted = (failures: number) => {
    let calls = 0
    const deleteOnce = Effect.flatMap(
      Effect.sync(() => {
        calls += 1
        return calls
      }),
      (n) => (n <= failures ? Effect.fail(preconditionFailure()) : Effect.void),
    )
    return { deleteOnce, calls: () => calls }
  }

  test('waits out a live dependency, then succeeds', async () => {
    const { deleteOnce, calls } = counted(2)
    await runPromise(runEffect(deleteOnce))

    expect(calls()).toBe(3)
  })

  test('a dependency that never goes fails with the API error (not a fake success)', async () => {
    const { deleteOnce, calls } = counted(Number.POSITIVE_INFINITY)
    const error = (await runPromise(Effect.flip(runEffect(deleteOnce)))) as { _tag: string; code: number }

    // initial attempt + the retry budget
    expect(calls()).toBe(13)
    expect(error._tag).toBe('GrpcError')
    expect(error.code).toBe(9)
  })
})

describe('identityChangeRequiresReplace', () => {
  test('returns replace when names differ', () => {
    expect(identityChangeRequiresReplace({ name: 'b' }, { name: 'a' })).toEqual({ action: 'replace' })
  })

  test('returns undefined when names and parents match', () => {
    expect(
      identityChangeRequiresReplace({ name: 'a', parentId: 'project-1' }, { name: 'a', parentId: 'project-1' }),
    ).toBeUndefined()
  })

  test('returns replace when the parent changes (a resource cannot be moved)', () => {
    expect(
      identityChangeRequiresReplace({ name: 'a', parentId: 'project-2' }, { name: 'a', parentId: 'project-1' }),
    ).toEqual({ action: 'replace' })
  })

  test('ignores a parent that is only stated explicitly on one side', () => {
    // `parentId` is optional and falls back to NEBIUS_PROJECT_ID at reconcile
    // time, so `undefined → set` usually means "now written down", not "moved".
    expect(identityChangeRequiresReplace({ name: 'a', parentId: 'project-1' }, { name: 'a' })).toBeUndefined()
    expect(identityChangeRequiresReplace({ name: 'a' }, { name: 'a', parentId: 'project-1' })).toBeUndefined()
  })

  test('with no olds, a pinned name plans a replace and an unnamed one does not', () => {
    // Pre-existing semantics (the deprecated helper behaved the same): a props
    // name with nothing persisted is a change; no name at all is not.
    expect(identityChangeRequiresReplace({ name: 'a' }, undefined)).toEqual({ action: 'replace' })
    expect(identityChangeRequiresReplace({}, undefined)).toBeUndefined()
    // A parent alone is never enough — nothing pinned, nothing to compare.
    expect(identityChangeRequiresReplace({ parentId: 'project-1' }, undefined)).toBeUndefined()
  })

  test('returns replace when olds has a name but news does not', () => {
    expect(identityChangeRequiresReplace({}, { name: 'a' })).toEqual({ action: 'replace' })
  })
})
