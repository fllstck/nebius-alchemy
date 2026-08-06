import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type { ScratchStack } from 'alchemy/Test/Bun'
import { DestroyFailedError, safeDestroy } from './cleanup.ts'

/**
 * Minimal structural ScratchStack whose destroy() behavior is injected.
 * safeDestroy only touches `stack.destroy()` — the other members are
 * never exercised.
 */
const fakeStack = (destroy: Effect.Effect<void, unknown, never>): ScratchStack =>
  ({
    name: 'fake',
    state: undefined,
    deploy: () => Effect.never,
    plan: () => Effect.never,
    destroy: () => destroy,
  }) as unknown as ScratchStack

const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(effect)

describe('safeDestroy', () => {
  test('returns the body value when body and destroy both succeed', async () => {
    const stack = fakeStack(Effect.void)
    const result = await run(
      safeDestroy(stack)(Effect.succeed('ok')),
    )
    expect(result).toBe('ok')
  })

  test('fails with DestroyFailedError when body succeeds but destroy fails', async () => {
    const stack = fakeStack(Effect.fail('destroy exploded'))
    const result = await run(
      safeDestroy(stack)(Effect.succeed('ok')).pipe(Effect.flip),
    )
    expect(result).toBeInstanceOf(DestroyFailedError)
    expect(result.message).toContain('destroy exploded')
  })

  test('surfaces the body error (not the destroy error) when both fail', async () => {
    const stack = fakeStack(Effect.fail('destroy exploded'))
    const result = await run(
      safeDestroy(stack)(Effect.fail('body error')).pipe(Effect.flip),
    )
    // The body's own failure must win — never masked by the cleanup failure.
    expect(result).toBe('body error')
  })

  test('redacts key material in the DestroyFailedError message', async () => {
    const stack = fakeStack(Effect.fail('request failed: secretKey=abc123'))
    const result = await run(
      safeDestroy(stack)(Effect.succeed('ok')).pipe(Effect.flip),
    )
    expect(result.message).toContain('<redacted>')
    expect(result.message).not.toContain('abc123')
  })

  test('propagates interruption after running destroy', async () => {
    let destroyed = false
    const stack = fakeStack(
      Effect.sync(() => {
        destroyed = true
      }),
    )
    const exit = await Effect.runPromise(
      safeDestroy(stack)(Effect.interrupt).pipe(Effect.exit),
    )
    expect(destroyed).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
