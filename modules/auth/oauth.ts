/**
 * In-process Nebius user-account OAuth (PKCE, authorization_code grant) —
 * Cloudflare-style, no `nebius` CLI dependency.
 *
 * Mirrors `alchemy/src/Cloudflare/Auth/OAuthClient.ts`: the authorize URL
 * uses the exact same wire shape as the CLI (client_id `nebius-cli`, S256
 * PKCE, dynamic `http://127.0.0.1:<port>` loopback redirect), and the
 * callback is served by a local `node:http` server with a paste-code
 * fallback for headless/remote sessions.
 *
 * Nebius user-account tokens are valid for 12h with NO refresh token (the
 * OIDC discovery document lists only `authorization_code` as a supported
 * grant) — so `login` must be re-run after expiry. This is inherent to the
 * platform, not the implementation; the `sa-key` method exists for automatic
 * renewal.
 */
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Schema from 'effect/Schema'
import { AUTH_SUCCESS_URL, AUTH_ERROR_URL } from 'alchemy/Auth/AuthProvider'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const OAUTH_AUTHORIZE_ENDPOINT = 'https://auth.nebius.com/oauth2/authorize'
export const OAUTH_TOKEN_ENDPOINT = 'https://auth.nebius.com/oauth2/token'
export const OAUTH_CLIENT_ID = 'nebius-cli'
export const OAUTH_SCOPE = 'openid'
export const OAUTH_CALLBACK_TIMEOUT = 5 * 60 * 1000

export class OAuthError extends Schema.TaggedErrorClass<OAuthError>()('OAuthError', {
  message: Schema.String,
}) {}

export interface OAuthCredentials {
  readonly type: 'oauth'
  readonly accessToken: string
  /** Epoch ms when the 12h token expires. */
  readonly expiresAt: number
}

export interface OAuthAuthorization {
  readonly verifier: string
  readonly state: string
  readonly redirectUri: string
}

const b64url = (buffer: Buffer): string => buffer.toString('base64url')

/** Generate PKCE verifier + S256 challenge + CSRF state (pure). */
export const createPkce = (): { verifier: string; challenge: string; state: string } => {
  const verifier = b64url(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, state: randomUUID() }
}

/** Build the authorize URL for a loopback redirect URI (pure). */
export const buildAuthorizeUrl = (params: {
  challenge: string
  state: string
  redirectUri: string
}): string => {
  const url = new URL(OAUTH_AUTHORIZE_ENDPOINT)
  url.searchParams.set('client_id', OAUTH_CLIENT_ID)
  url.searchParams.set('code_challenge', params.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', OAUTH_SCOPE)
  url.searchParams.set('state', params.state)
  return url.toString()
}

/**
 * Start a loopback callback server on an ephemeral 127.0.0.1 port.
 * `waitForCode` resolves with the authorization code once the browser hits
 * the callback (state-validated), bounded by {@link OAUTH_CALLBACK_TIMEOUT}.
 */
export const startCallbackServer = (
  expectedState: string,
): Effect.Effect<
  { readonly port: number; readonly waitForCode: Effect.Effect<string, OAuthError>; readonly close: Effect.Effect<void> },
  OAuthError
> =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<string, OAuthError>()

    const server = yield* Effect.sync(() =>
      createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (code != null && state === expectedState) {
          // Same Alchemy-styled landing page as the Cloudflare provider.
          res.writeHead(302, { Location: AUTH_SUCCESS_URL })
          res.end()
          void Effect.runPromise(Deferred.succeed(deferred, code))
        } else {
          res.writeHead(302, { Location: AUTH_ERROR_URL })
          res.end()
          // Leave the deferred pending on bad input — the paste fallback (or
          // the 5-minute timeout) still has a chance to complete the login.
        }
      }),
    )

    const port = yield* Effect.tryPromise(
      () =>
        new Promise<number>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject)
            resolve((server.address() as AddressInfo).port)
          })
        }),
    ).pipe(
      Effect.mapError(
        (e) => new OAuthError({ message: `Failed to start OAuth callback server: ${e instanceof Error ? e.message : String(e)}` }),
      ),
    )

    const waitForCode = deferred.pipe(
      Deferred.await,
      Effect.timeoutOrElse({
        duration: OAUTH_CALLBACK_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new OAuthError({ message: 'Timed out waiting for the Nebius browser login (5 minutes).' }),
          ),
      }),
    )

    const close = Effect.sync(() => server.close())

    return { port, waitForCode, close }
  })

/**
 * Exchange an authorization code for a 12h access token (public client,
 * PKCE verifier in the body — same request the CLI makes).
 */
export const exchangeCode = (
  code: string,
  verifier: string,
  redirectUri: string,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.tryPromise(() =>
    fetch(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    }).then(async (res) => {
      if (!res.ok) {
        throw new Error(`token endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const json = (await res.json()) as { access_token: string; expires_in: number }
      if (!json.access_token || typeof json.expires_in !== 'number') {
        throw new Error('token response missing access_token/expires_in')
      }
      return {
        type: 'oauth' as const,
        accessToken: json.access_token,
        expiresAt: Date.now() + json.expires_in * 1000,
      }
    }),
  ).pipe(
    Effect.mapError(
      (e) =>
        new OAuthError({
          message: `Nebius OAuth token exchange failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    ),
  )

/**
 * Parse a pasted value — a raw authorization code OR a callback URL — into
 * `{ code, state }` (pure). `state` is null for a raw code.
 */
export const parseCallbackInput = (input: string): { code: string; state: string | null } => {
  const value = input.trim()
  if (value.startsWith('http://') || value.startsWith('https://')) {
    const url = new URL(value)
    return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state') }
  }
  return { code: value, state: null }
}

/**
 * Parse a pasted value — a raw authorization code OR a callback URL — and
 * exchange it. State is validated when a URL is pasted.
 */
export const exchangeCallbackInput = (
  input: string,
  authorization: OAuthAuthorization,
): Effect.Effect<OAuthCredentials, OAuthError> => {
  const { code, state } = parseCallbackInput(input)
  if (!code) {
    return Effect.fail(new OAuthError({ message: 'No authorization code found in the pasted input.' }))
  }
  if (state !== null && state !== authorization.state) {
    return Effect.fail(new OAuthError({ message: 'The authorization state does not match.' }))
  }
  return exchangeCode(code, authorization.verifier, authorization.redirectUri)
}
