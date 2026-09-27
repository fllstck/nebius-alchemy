/**
 * `getOrUndefined` — the lookup half of R-06.
 *
 * The rule this pins is narrow on purpose, and every other outcome is a failure the caller must see:
 * **only** `NOT_FOUND` becomes `undefined`. A `PERMISSION_DENIED` that read as `undefined` is the bug
 * R-06 was written for — the caller's `if (!resource)` branch would then *create* the resource, so a
 * credential problem turns into a duplicate. It is why this is 62 call sites' single implementation
 * rather than a `catch` anywhere.
 *
 * The defect case matters too: `catchIf` does not run for a defect or an interrupt, and a bug in the
 * lookup is not "the resource is absent".
 */
import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'

import { getOrUndefined, isNotFound } from '../../../modules/resources/shared/not-found.ts'
import { GrpcError, GrpcDeadlineExceededError } from '../../../modules/api-client/grpc-utils.ts'

const grpcError = (code: number, message = 'nope') => new GrpcError({ code, message, details: '' })

describe('getOrUndefined', () => {
  test('passes a found resource through untouched', async () => {
    const result = await Effect.runPromise(getOrUndefined(Effect.succeed({ id: 'network-1' })))

    expect(result).toEqual({ id: 'network-1' })
  })

  test('NOT_FOUND answers undefined — the resource is absent, so the caller may create it', async () => {
    const result = await Effect.runPromise(getOrUndefined(Effect.fail(grpcError(5, 'NotFound'))))

    expect(result).toBeUndefined()
  })

  test('PERMISSION_DENIED propagates — it must never read as "absent"', async () => {
    const exit = await Effect.runPromiseExit(getOrUndefined(Effect.fail(grpcError(7, 'PermissionDenied'))))

    expect(exit._tag).toBe('Failure')
    // The original error, not a rewrap: callers `catchTag` on `GrpcError` and read `code`.
    expect(exit._tag === 'Failure' && String(exit.cause)).toContain('PermissionDenied')
  })

  test('a deadline propagates — it carries no code, so it is not NOT_FOUND', async () => {
    const exit = await Effect.runPromiseExit(
      getOrUndefined(Effect.fail(new GrpcDeadlineExceededError({ message: 'deadline exceeded' }))),
    )

    expect(exit._tag).toBe('Failure')
  })

  test('only code 5 is NOT_FOUND — 6 (ALREADY_EXISTS) is not, and neither is 0', async () => {
    const exits = await Promise.all(
      [0, 6, 14].map((code) => Effect.runPromiseExit(getOrUndefined(Effect.fail(grpcError(code))))),
    )

    expect(exits.map((exit) => exit._tag)).toEqual(['Failure', 'Failure', 'Failure'])
    expect(await Effect.runPromise(getOrUndefined(Effect.fail(grpcError(5))))).toBeUndefined()
  })

  test('a defect is not caught — a broken lookup is not a missing resource', async () => {
    const exit = await Effect.runPromiseExit(getOrUndefined(Effect.die(new Error('bug'))))

    expect(exit._tag).toBe('Failure')
  })
})

describe('isNotFound', () => {
  test('recognises code 5 on a real GrpcError', () => {
    expect(isNotFound(grpcError(5))).toBe(true)
    expect(isNotFound(grpcError(4))).toBe(false)
  })

  test('recognises a structural `{ _tag: "GrpcError", code: 5 }` — the shape the service mocks use', () => {
    // Tag-based like `catchTag`, NOT `instanceof`: the gRPC service doubles in `tests/helpers/mocks.ts`
    // are plain objects, and an `instanceof` guard silently stops catching them (that is how
    // `quotas/v1 unit.test.ts`'s NOT_FOUND case caught this helper's first implementation).
    expect(isNotFound({ _tag: 'GrpcError', code: 5 })).toBe(true)
    expect(isNotFound({ _tag: 'GrpcError', code: 7 })).toBe(false)
  })

  test('is false for a differently tagged error, a plain Error and a non-object', () => {
    expect(isNotFound({ _tag: 'GrpcDeadlineExceededError', code: 5 })).toBe(false)
    expect(isNotFound(new Error('not found'))).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
    expect(isNotFound('5')).toBe(false)
  })
})
