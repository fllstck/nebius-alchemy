import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as OAuth from '../../modules/auth/oauth.ts'

const failureMessage = (effect: Effect.Effect<unknown, OAuth.OAuthError, never>) =>
  Effect.runPromise(Effect.catch(effect, (e) => Effect.succeed(e.message)))

describe('OAuth.createPkce', () => {
  test('produces a verifier, a matching S256 challenge and a state', () => {
    const { verifier, challenge, state } = OAuth.createPkce()
    expect(verifier.length).toBeGreaterThanOrEqual(32)
    expect(state.length).toBeGreaterThan(10)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })
})

describe('OAuth.buildAuthorizeUrl', () => {
  test('carries the PKCE + client + loopback redirect params', () => {
    const url = new URL(
      OAuth.buildAuthorizeUrl({ challenge: 'the-challenge', state: 'the-state', redirectUri: 'http://127.0.0.1:4321' }),
    )
    expect(url.origin).toBe('https://auth.nebius.com')
    expect(url.pathname).toBe('/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('nebius-cli')
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4321')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('openid')
    expect(url.searchParams.get('state')).toBe('the-state')
  })

  test('honors an explicit client id override', () => {
    const url = new URL(
      OAuth.buildAuthorizeUrl({
        challenge: 'c',
        state: 's',
        redirectUri: 'http://127.0.0.1:4321',
        clientId: 'my-registered-client',
      }),
    )
    expect(url.searchParams.get('client_id')).toBe('my-registered-client')
  })
})

describe('OAuth.parseCallbackInput', () => {
  test('treats a bare value as a raw code', () => {
    expect(OAuth.parseCallbackInput('  auth-code-123  ')).toEqual({ code: 'auth-code-123', state: null })
  })

  test('extracts code + state from a full callback URL', () => {
    expect(OAuth.parseCallbackInput('http://127.0.0.1:4321/?code=xyz&state=st1')).toEqual({
      code: 'xyz',
      state: 'st1',
    })
  })

  test('returns empty code when the URL has none', () => {
    expect(OAuth.parseCallbackInput('http://127.0.0.1:4321/?state=st1')).toEqual({ code: '', state: 'st1' })
  })
})

describe('OAuth.exchangeCallbackInput (fails before any network call)', () => {
  const authorization: OAuth.OAuthAuthorization = {
    verifier: 'v',
    state: 'expected-state',
    redirectUri: 'http://127.0.0.1:1',
    clientId: 'nebius-cli',
  }

  test('rejects a mismatched state', async () => {
    const message = await failureMessage(
      OAuth.exchangeCallbackInput('http://127.0.0.1:1/?code=c&state=wrong', authorization),
    )
    expect(message).toContain('state does not match')
  })

  test('rejects a URL with no code', async () => {
    const message = await failureMessage(OAuth.exchangeCallbackInput('http://127.0.0.1:1/?state=expected-state', authorization))
    expect(message).toContain('No authorization code')
  })
})

describe('OAuth.resolveClientId', () => {
  const ENV = OAuth.OAUTH_CLIENT_ID_ENV
  const original = process.env[ENV]

  afterEach(() => {
    if (original === undefined) delete process.env[ENV]
    else process.env[ENV] = original
  })

  test('defaults to the shared nebius-cli client when unset', () => {
    delete process.env[ENV]
    expect(OAuth.resolveClientId()).toBe('nebius-cli')
  })

  test('honors the env override', () => {
    process.env[ENV] = 'my-registered-client'
    expect(OAuth.resolveClientId()).toBe('my-registered-client')
  })

  test('falls back to the default for blank values', () => {
    process.env[ENV] = '   '
    expect(OAuth.resolveClientId()).toBe('nebius-cli')
  })
})

describe('OAuth constants', () => {
  test('token endpoint + client match the platform', () => {
    expect(OAuth.OAUTH_TOKEN_ENDPOINT).toBe('https://auth.nebius.com/oauth2/token')
    expect(OAuth.OAUTH_CLIENT_ID).toBe('nebius-cli')
  })
})
