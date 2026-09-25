/**
 * `bestEffortList` — the tenant fan-out's failure policy (R-06).
 *
 * The policy has three parts and all three are load-bearing, which is why they are pinned here rather
 * than left to the twenty call sites: `NOT_FOUND` is quiet (a parent deleted between the project list
 * and this call), any other failure answers `[]` **and** logs (a partial enumeration must not read as a
 * complete one), and a defect is not swallowed at all.
 */
import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'

import { bestEffortList } from '../../../modules/resources/shared/fan-out.ts'
import { GrpcError, GrpcDeadlineExceededError } from '../../../modules/api-client/grpc-utils.ts'
import { recordingLogs } from '../../helpers/mocks.ts'

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
