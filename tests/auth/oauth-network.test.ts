/**
 * The OAuth **network half**: the token exchange and the loopback callback server.
 *
 * `tests/auth/oauth.test.ts` covers the pure half (PKCE, authorize URL, callback parsing, client-id
 * resolution). This file covers what that one structurally cannot — everything that talks to the
 * outside:
 *
 *   * `exchangeCode` against a `fetch` double (`stubTokenEndpoint`): the request body the platform
 *     requires, the 12h `expiresAt` arithmetic, and both failure shapes (a non-2xx with a body, and
 *     a 2xx with a malformed body) whose message is the only thing an operator can act on;
 *   * `startCallbackServer` against a **real** loopback listener — the success redirect, the
 *     bad-state redirect that deliberately leaves the deferred pending (the paste fallback must
 *     still get its chance), a missing `code`, the bounded timeout, and that `close` frees the port
 *     (a leaked listener would keep the process alive).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as OAuth from '../../modules/auth/oauth.ts'
import { stubTokenEndpoint } from '../helpers/oauth-token-double.ts'

const failureMessage = (effect: Effect.Effect<unknown, OAuth.OAuthError, never>) =>
  Effect.runPromise(Effect.catch(effect, (e) => Effect.succeed(e.message)))

const doubles = { current: undefined as ReturnType<typeof stubTokenEndpoint> | undefined }

afterEach(() => {
  doubles.current?.restore()
  doubles.current = undefined
})

describe('OAuth.exchangeCode (fetch double)', () => {
  test('posts the PKCE code exchange the platform requires and converts expires_in to an epoch ms', async () => {
    double(() => Response.json({ access_token: 'token-abc', expires_in: 3600 }))

    const before = Date.now()
    const credentials = await Effect.runPromise(
      OAuth.exchangeCode('the-code', 'the-verifier', 'http://127.0.0.1:4321', 'my-client'),
    )

    expect(credentials.type).toBe('oauth')
    expect(credentials.accessToken).toBe('token-abc')
    // 12h tokens: the epoch must be ~3600s ahead, not the raw `expires_in`.
    expect(credentials.expiresAt).toBeGreaterThanOrEqual(before + 3600_000)
    expect(credentials.expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000)

    const request = doubles.current!.requests[0]!
    expect(request.url).toBe(OAuth.OAUTH_TOKEN_ENDPOINT)
    expect(request.method).toBe('POST')
    expect(request.contentType).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(request.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:4321',
      client_id: 'my-client',
      // The public-client proof: the verifier travels in the body (no client secret).
      code_verifier: 'the-verifier',
    })
  })

  test('defaults the client id to the shared nebius-cli client', async () => {
    double(() => Response.json({ access_token: 't', expires_in: 1 }))
    await Effect.runPromise(OAuth.exchangeCode('c', 'v', 'http://127.0.0.1:1'))
    expect(doubles.current!.requests[0]!.body.get('client_id')).toBe('nebius-cli')
  })

  test('a rejected exchange names the status and quotes the body (the answer an operator needs)', async () => {
    double(() => new Response('invalid_client: unknown client', { status: 401 }))

    const message = await failureMessage(OAuth.exchangeCode('c', 'v', 'http://127.0.0.1:1'))
    expect(message).toContain('Nebius OAuth token exchange failed:')
    expect(message).toContain('token endpoint returned 401')
    expect(message).toContain('invalid_client: unknown client')
  })

  test('a malformed 2xx body is rejected rather than producing a token-less credential', async () => {
    double(() => Response.json({ access_token: 'only-a-token' }))

    const message = await failureMessage(OAuth.exchangeCode('c', 'v', 'http://127.0.0.1:1'))
    expect(message).toContain('token response missing access_token/expires_in')
  })

  test('a string expires_in is rejected too (the schema is not "truthy enough")', async () => {
    double(() => Response.json({ access_token: 't', expires_in: '3600' }))

    const message = await failureMessage(OAuth.exchangeCode('c', 'v', 'http://127.0.0.1:1'))
    expect(message).toContain('token response missing access_token/expires_in')
  })

  test('a network-level rejection is reported as an OAuthError, not a defect', async () => {
    double(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443')
    })

    const message = await failureMessage(OAuth.exchangeCode('c', 'v', 'http://127.0.0.1:1'))
    expect(message).toContain('Nebius OAuth token exchange failed:')
    expect(message).toContain('ECONNREFUSED')
  })
})

describe('OAuth.startCallbackServer (real loopback listener)', () => {
  test('a state-matching callback redirects to the success page and resolves the code', async () => {
    const server = await Effect.runPromise(OAuth.startCallbackServer('expected-state'))
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/?code=the-code&state=expected-state`, {
        redirect: 'manual',
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toContain('alchemy')

      expect(await Effect.runPromise(server.waitForCode)).toBe('the-code')
    } finally {
      await Effect.runPromise(server.close)
    }
  })

  test('a state mismatch redirects to the error page and does NOT resolve (the paste fallback keeps its chance)', async () => {
    const server = await Effect.runPromise(OAuth.startCallbackServer('expected-state'))
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/?code=the-code&state=wrong`, { redirect: 'manual' })
      expect(response.status).toBe(302)

      // Still pending: the deferred must not have been completed. A short timeout is the assertion.
      const outcome = await Effect.runPromise(
        server.waitForCode.pipe(
          Effect.timeoutOrElse({ duration: 150, orElse: () => Effect.succeed('still-pending') }),
        ),
      )
      expect(outcome).toBe('still-pending')
    } finally {
      await Effect.runPromise(server.close)
    }
  })

  test('a callback with no code at all is not an error page for a *code* — it stays pending', async () => {
    const server = await Effect.runPromise(OAuth.startCallbackServer('expected-state'))
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/?state=expected-state`, { redirect: 'manual' })
      expect(response.status).toBe(302)

      const outcome = await Effect.runPromise(
        server.waitForCode.pipe(
          Effect.timeoutOrElse({ duration: 150, orElse: () => Effect.succeed('still-pending') }),
        ),
      )
      expect(outcome).toBe('still-pending')
    } finally {
      await Effect.runPromise(server.close)
    }
  })

  test('an unanswered callback times out with the message a headless user sees', async () => {
    const server = await Effect.runPromise(OAuth.startCallbackServer('expected-state', 50))
    try {
      const message = await failureMessage(server.waitForCode)
      expect(message).toContain('Timed out waiting for the Nebius browser login')
      expect(message).toContain('5 minutes')
    } finally {
      await Effect.runPromise(server.close)
    }
  })

  test('close() frees the port (an autoreload-forever listener would hang the process)', async () => {
    const server = await Effect.runPromise(OAuth.startCallbackServer('s'))
    await Effect.runPromise(server.close)

    // The listener is gone: connecting must now be refused. `fetch` rejects, which is the assertion.
    const refused = await fetch(`http://127.0.0.1:${server.port}/?code=c&state=s`, { redirect: 'manual' }).then(
      () => false,
      () => true,
    )
    expect(refused).toBe(true)
  })
})

describe('OAuth.exchangeCallbackInput (the paste fallback, through the real exchange)', () => {
  test('a pasted callback URL exchanges its code and validates state', async () => {
    double(() => Response.json({ access_token: 'pasted-token', expires_in: 60 }))
    const authorization: OAuth.OAuthAuthorization = {
      verifier: 'v',
      state: 'the-state',
      redirectUri: 'http://127.0.0.1:1',
      clientId: 'nebius-cli',
    }

    const credentials = await Effect.runPromise(
      OAuth.exchangeCallbackInput(`http://127.0.0.1:1/?code=pasted-code&state=the-state`, authorization),
    )
    expect(credentials.accessToken).toBe('pasted-token')
    expect(doubles.current!.requests[0]!.body.get('code')).toBe('pasted-code')
    expect(doubles.current!.requests[0]!.body.get('code_verifier')).toBe('v')
  })

  test('a bare pasted code (no URL, so no state) is accepted', async () => {
    double(() => Response.json({ access_token: 'bare-token', expires_in: 60 }))
    const authorization: OAuth.OAuthAuthorization = {
      verifier: 'v',
      state: 'the-state',
      redirectUri: 'http://127.0.0.1:1',
      clientId: 'nebius-cli',
    }

    const credentials = await Effect.runPromise(OAuth.exchangeCallbackInput('  bare-code  ', authorization))
    expect(credentials.accessToken).toBe('bare-token')
    expect(doubles.current!.requests[0]!.body.get('code')).toBe('bare-code')
  })
})

const double = (respond: () => Response) => {
  doubles.current = stubTokenEndpoint(respond)
}
