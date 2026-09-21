import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import { tryPromiseRaw } from '../modules/effect-utils.ts'

const { describe, expect, test } = BunTest

/**
 * Pins the difference between the two `Effect.tryPromise` forms.
 *
 * The thunk form wraps every rejection in Effect's `UnknownError`, so a caller
 * that classifies or renders the failure sees the wrapper instead of the real
 * error. That silently broke (a) the hosted S3 retry predicate
 * (`error instanceof S3Errors.ServerError` was never true, so permanent 4xx were
 * retried) and (b) the OAuth token-exchange message (an `invalid_client`
 * rejection reported "An error occurred in Effect.tryPromise").
 */
describe('tryPromiseRaw', () => {
  test('fails with the raw rejection, not Effect’s UnknownError wrapper', async () => {
    const original = Object.assign(new Error('token endpoint returned 401: invalid_client'), { statusCode: 401 })

    const failure = await Effect.runPromise(
      Effect.flip(tryPromiseRaw(() => Promise.reject(original))),
    )

    expect(failure).toBe(original)
    expect((failure as Error).message).toContain('invalid_client')
    expect((failure as { statusCode: number }).statusCode).toBe(401)
  })

  test('the thunk form does NOT — it substitutes a generic wrapper (the regression)', async () => {
    const original = new Error('AccessDenied: the grant has not propagated yet')

    const failure = await Effect.runPromise(
      Effect.flip(Effect.tryPromise(() => Promise.reject(original))),
    )

    expect(failure).not.toBe(original)
    expect(String((failure as Error).message)).toBe('An error occurred in Effect.tryPromise')
    // The original survives only as `cause`, which the retry predicates and
    // message renderers never read.
    expect((failure as { cause?: unknown }).cause).toBe(original)
  })

  test('passes a resolved value through unchanged', async () => {
    expect(await Effect.runPromise(tryPromiseRaw(() => Promise.resolve('ok')))).toBe('ok')
  })
})
