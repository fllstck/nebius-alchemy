/**
 * The **OAuth token endpoint double** — a `fetch` seam.
 *
 * `modules/auth/oauth.ts` posts to a module constant (`OAUTH_TOKEN_ENDPOINT`), so there is no
 * injectable transport to provide: patching the global `fetch` for the duration of a test is the
 * only honest double, and it exercises the real request construction (body fields, headers) rather
 * than a reimplementation of it.
 *
 * Restore is explicit and must be in an `afterEach`/`finally` — the patch is process-global. Each
 * bun test file runs in its own process and tests within a file run in order, so a leak cannot
 * reach another file, but it can reach the next test.
 *
 * `respond` receives the parsed request so a test can assert the wire shape *and* choose the reply:
 *
 *   const double = stubTokenEndpoint(() => Response.json({ access_token: 'tok', expires_in: 3600 }))
 *   try { ... } finally { double.restore() }
 *
 * Only requests matching `match` (by default: the token endpoint's path) are intercepted — everything
 * else is passed through to the real `fetch`. That default is load-bearing: the OAuth login flow
 * ALSO fetches its loopback callback server (`http://127.0.0.1:<port>`), and a stub that swallowed
 * that request would leave the login waiting for a browser hit that never lands (which is exactly
 * how the callback-arm test first failed).
 */
export interface TokenRequest {
  readonly url: string
  readonly method: string | undefined
  readonly contentType: string | undefined
  readonly body: URLSearchParams
}

export const stubTokenEndpoint = (
  respond: (request: TokenRequest) => Response,
  options: { readonly match?: (url: string) => boolean } = {},
) => {
  const match = options.match ?? ((url: string) => url.includes('/oauth2/token'))
  const requests: Array<TokenRequest> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | { url: string }, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!match(url)) return original(input as never, init)
    const headers = new Headers(init?.headers)
    const request: TokenRequest = {
      url,
      method: init?.method,
      contentType: headers.get('content-type') ?? undefined,
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    }
    requests.push(request)
    return respond(request)
  }) as typeof fetch

  return {
    requests,
    restore: () => {
      globalThis.fetch = original
    },
  }
}
