/**
 * `bestEffortList` — the tenant fan-out's failure policy (R-06).
 *
 * The policy has three parts and all three are load-bearing, which is why they are pinned here rather
 * than left to the twenty call sites: `NOT_FOUND` is quiet (a parent deleted between the project list
 * and this call), any other failure answers `[]` **and** logs (a partial enumeration must not read as a
 * complete one), and a defect is not swallowed at all.
 */
import { describe, expect, test } from 'bun:test'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { bestEffortList, forEachParent, resolveParentIds } from '../../../modules/resources/shared/fan-out.ts'
import { GrpcError, GrpcDeadlineExceededError } from '../../../modules/api-client/grpc-utils.ts'
import { mockIamLayer, recordingLogs, testConfigLayer } from '../../helpers/mocks.ts'

const grpcError = (code: number, message = 'nope') => new GrpcError({ code, message, details: '' })

/** Run a fan-out step and report both what it answered and what it said. */
const run = async (effect: Effect.Effect<ReadonlyArray<number>, never, never>) => {
  const logs = recordingLogs()
  return {
    result: await Effect.runPromise(Effect.provide(effect, logs.layer)),
    messages: logs.messages(),
  }
}

describe('bestEffortList', () => {
  test('passes a successful enumeration through untouched', async () => {
    const { result, messages } = await run(bestEffortList('networks in project-1', Effect.succeed([1, 2, 3])))

    expect([...result]).toEqual([1, 2, 3])
    expect(messages).toEqual([])
  })

  test('a NOT_FOUND parent is quiet — it was deleted, which is the benign case', async () => {
    const { result, messages } = await run(bestEffortList('networks in project-gone', Effect.fail(grpcError(5))))

    expect([...result]).toEqual([])
    expect(messages).toEqual([])
  })

  test('PERMISSION_DENIED answers [] but says so — the result is PARTIAL, not empty', async () => {
    const { result, messages } = await run(
      bestEffortList('networks in project-2', Effect.fail(grpcError(7, 'PermissionDenied'))),
    )

    expect([...result]).toEqual([])
    expect(messages).toHaveLength(1)
    // Names the parent (so the operator knows which project to fix) and the error (so they know what
    // to fix), and says out loud that the empty list is not a complete one.
    expect(messages[0]).toContain('networks in project-2')
    expect(messages[0]).toContain('7 PermissionDenied')
    expect(messages[0]).toContain('PARTIAL')
  })

  test('UNAVAILABLE is treated like any other non-NOT_FOUND failure', async () => {
    const { result, messages } = await run(bestEffortList('zones in project-3', Effect.fail(grpcError(14, 'Unavailable'))))

    expect([...result]).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('14 Unavailable')
  })

  test('a deadline is reported by tag, since it carries no code', async () => {
    const { result, messages } = await run(
      bestEffortList('records in zone-1', Effect.fail(new GrpcDeadlineExceededError({ message: 'deadline exceeded' }))),
    )

    expect([...result]).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('deadline exceeded')
    expect(messages[0]).toContain('records in zone-1')
  })

  test('a defect is NOT swallowed — a bug in the enumeration is not a missing parent', async () => {
    const exit = await Effect.runPromiseExit(bestEffortList('networks in project-1', Effect.die(new Error('bug'))))

    expect(exit._tag).toBe('Failure')
  })
})

/**
 * `forEachParent` — the fan-out's shape (R-12's second half).
 *
 * It exists so the 23 hand-written fan-outs share one concurrency setting and one flattening step. The
 * failures are `bestEffortList`'s (pinned above); what is pinned *here* is that the parents are
 * enumerated concurrently and that each level's rows are flattened into one array.
 */
describe('forEachParent', () => {
  test('enumerates parents concurrently — a parent blocked on another parent still finishes', async () => {
    // `blocker` is enumerated FIRST and cannot finish until `releaser` has run. Sequentially, this
    // never completes; the timeout turns that into an assertion failure instead of a hung suite.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>()
        return yield* forEachParent(
          ['blocker', 'releaser'],
          (parentId) => `resources in ${parentId}`,
          (parentId) =>
            parentId === 'blocker'
              ? Effect.map(Deferred.await(released), () => [1])
              : Effect.andThen(Deferred.succeed(released, undefined), Effect.succeed([2])),
        )
      }).pipe(
        // `Effect.forEach` preserves input order, so the flattened result is stable.
        Effect.timeoutOrElse({ duration: 1000, orElse: () => Effect.succeed('sequential' as const) }),
      ),
    )

    expect(result).toEqual([1, 2])
  })

  test('flattens one level per parent, and a gone parent contributes nothing', async () => {
    const result = await Effect.runPromise(
      forEachParent(['parent-1', 'parent-gone', 'parent-2'], (parentId) => `resources in ${parentId}`, (parentId) =>
        parentId === 'parent-gone'
          // NOT_FOUND is the quiet arm — no warning to capture, no partial-result noise.
          ? Effect.fail(grpcError(5))
          : Effect.succeed([`${parentId}-a`, `${parentId}-b`]),
      ),
    )

    expect(result).toEqual(['parent-1-a', 'parent-1-b', 'parent-2-a', 'parent-2-b'])
  })
})

/**
 * `resolveParentIds` — the parents a tenant fan-out enumerates.
 *
 * The interesting property is *what it does not do*: with an explicit `parentId` it must not touch the
 * tenant at all. Every call site used to resolve `NEBIUS_TENANT_ID` eagerly at action-construction
 * time, so a `List*({ parentId })` call failed with `MissingTenantIdError` when the variable was unset
 * — even though `tenant.ts` documents the tenant as needed "only where something genuinely lists
 * across projects". That is why the first test runs with an **empty** config provider and a project
 * list that dies if it is reached.
 */
describe('resolveParentIds', () => {
  /** Config provider with no tenant, so any tenant resolution fails loudly. */
  const noTenant = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

  test('an explicit parentId is the whole answer — the tenant is never read', async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        resolveParentIds('project-explicit'),
        Layer.mergeAll(
          noTenant,
          mockIamLayer({
            project: {
              list: () => Effect.die('the project list must not be called when a parentId was given'),
            },
          }),
        ),
      ),
    )

    expect([...result]).toEqual(['project-explicit'])
  })

  test('without a parentId every project of the tenant is enumerated', async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        resolveParentIds(undefined),
        Layer.mergeAll(
          testConfigLayer,
          mockIamLayer({
            project: {
              list: () => Effect.succeed([{ metadata: { id: 'project-a' } }, { metadata: { id: 'project-b' } }]),
            },
          }),
        ),
      ),
    )

    expect([...result]).toEqual(['project-a', 'project-b'])
  })

  test('a failing project list is NOT best-effort — it would read as "this tenant has no projects"', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        resolveParentIds(undefined),
        Layer.mergeAll(testConfigLayer, mockIamLayer({ project: { list: () => Effect.fail(grpcError(5)) } })),
      ),
    )

    expect(exit._tag).toBe('Failure')
  })
})
