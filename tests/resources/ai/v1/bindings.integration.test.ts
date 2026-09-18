/**
 * M3 — local-mock runtime tests for the AI endpoint bindings (AD4).
 *
 * NOT cloud-gated: these run against a local `Bun.serve` OpenAI-compatible
 * mock (zero cost, zero provisioning, seconds). The real-endpoint e2e —
 * deploy-time wiring + live chat — is the SLOW_TESTS-gated M6 stage.
 */
import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Self } from 'alchemy/Self'
import * as Bindings from '../../../../modules/resources/ai/v1/bindings.ts'
import * as BindingsSchema from '../../../../modules/resources/ai/v1/bindings.schema.ts'
import type { NebiusEndpoint } from '../../../../modules/resources/ai/v1/endpoint.ts'
import { defaultStreamFrames, startOpenAiMock } from '../../../helpers/openai-mock.ts'

/** The Worker resource's Self service — a mock host satisfies it (both the generic tag `Binding.Host` resolves and the per-type tag). */
// oxlint-disable-next-line no-explicit-any — mock host satisfies the Worker shape
const mockSelf = (host: any) =>
  Layer.mergeAll(Layer.succeed(Self, host), Layer.succeed(Self('Cloudflare.Worker'), host))

/** Build resolved env for the mock URL. */
const valuesFor = (mockUrl: string, token = 'test-token'): Bindings.AiEnv => ({
  NEBIUS_ENDPOINT_URL: mockUrl,
  NEBIUS_ENDPOINT_AUTH_TOKEN: token,
})

const chat = (mock: ReturnType<typeof startOpenAiMock>, request: BindingsSchema.ChatCompletionRequest, token?: string) =>
  Bindings.chatCompletions(valuesFor(mock.url, token))(request)

const runChat = (
  mock: ReturnType<typeof startOpenAiMock>,
  request: BindingsSchema.ChatCompletionRequest,
  token?: string,
) => Effect.runPromise(chat(mock, request, token))

const simpleRequest = (stream = false) =>
  new BindingsSchema.ChatCompletionRequest({
    model: 'mock-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...(stream ? { stream: true } : {}),
  })

describe('Nebius.ai.v1 bindings — runtime client', () => {
  test('non-stream round-trip with Bearer auth', async () => {
    const mock = startOpenAiMock()
    try {
      const result = await runChat(mock, simpleRequest())
      expect(result.stream).toBe(false)
      if (result.stream === false) {
        expect(result.response.choices[0]?.message.content).toBe('mock reply')
      }
      // The wire request: POST /v1/chat/completions, Bearer token, encoded body.
      expect(mock.requests).toHaveLength(1)
      expect(mock.requests[0]?.method).toBe('POST')
      expect(mock.requests[0]?.path).toBe('/v1/chat/completions')
      expect(mock.requests[0]?.authorization).toBe('Bearer test-token')
      expect(mock.requests[0]?.body).toEqual({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello' }],
      })
    } finally {
      mock.stop()
    }
  })

  test('empty token → no Authorization header', async () => {
    const mock = startOpenAiMock()
    try {
      await runChat(mock, simpleRequest(), '')
      expect(mock.requests[0]?.authorization).toBeNull()
    } finally {
      mock.stop()
    }
  })

  test('stream round-trip: typed chunks collected', async () => {
    const mock = startOpenAiMock({ streamFrames: defaultStreamFrames() })
    try {
      const result = await runChat(mock, simpleRequest(true))
      expect(result.stream).toBe(true)
      if (result.stream === true) {
        const chunks: BindingsSchema.ChatCompletionChunk[] = []
        const reader = result.chunks.getReader()
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop — stream reads are inherently sequential
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        const content = chunks.flatMap((c) => c.choices.flatMap((ch) => ch.delta.content ?? []))
        expect(content.join('')).toBe('Hello')
        expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop')
      }
    } finally {
      mock.stop()
    }
  })

  test('401 → EndpointUnauthorized with the error message', async () => {
    const mock = startOpenAiMock({
      status: 401,
      errorBody: { error: { message: 'invalid token', type: 'authentication_error', code: 'invalid_api_key' } },
    })
    try {
      const error = await Effect.runPromise(
        Effect.flip(chat(mock, simpleRequest())),
      )
      expect(error._tag).toBe('EndpointUnauthorized')
      if (error._tag === 'EndpointUnauthorized') {
        expect(error.message).toBe('invalid token')
      }
    } finally {
      mock.stop()
    }
  })

  test('404 → EndpointNotFound', async () => {
    const mock = startOpenAiMock({
      status: 404,
      errorBody: { error: { message: 'model not found', type: 'invalid_request_error', code: 'model_not_found' } },
    })
    try {
      const error = await Effect.runPromise(Effect.flip(chat(mock, simpleRequest())))
      expect(error._tag).toBe('EndpointNotFound')
    } finally {
      mock.stop()
    }
  })

  test('429 → EndpointRateLimited', async () => {
    const mock = startOpenAiMock({
      status: 429,
      errorBody: { error: { message: 'slow down', type: 'rate_limit_error' } },
    })
    try {
      const error = await Effect.runPromise(Effect.flip(chat(mock, simpleRequest())))
      expect(error._tag).toBe('EndpointRateLimited')
    } finally {
      mock.stop()
    }
  })

  test('5xx → EndpointError preserving type and code', async () => {
    const mock = startOpenAiMock({
      status: 500,
      errorBody: { error: { message: 'boom', type: 'server_error', code: 'internal' } },
    })
    try {
      const error = await Effect.runPromise(Effect.flip(chat(mock, simpleRequest())))
      expect(error._tag).toBe('EndpointError')
      if (error._tag === 'EndpointError') {
        expect(error.statusCode).toBe(500)
        expect(error.type).toBe('server_error')
        expect(error.code).toBe('internal')
        expect(error.message).toBe('boom')
      }
    } finally {
      mock.stop()
    }
  })

  test('non-JSON error body falls back to the raw text', async () => {
    // A raw-text error page (no OpenAI error body) — the message falls back
    // to the body text.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('<html>bad gateway</html>', { status: 502 }),
    })
    try {
      const error = await Effect.runPromise(
        Effect.flip(chat({ url: server.url.toString(), requests: [], stop: () => {} }, simpleRequest())),
      )
      expect(error._tag).toBe('EndpointError')
      if (error._tag === 'EndpointError') {
        expect(error.message).toBe('<html>bad gateway</html>')
      }
    } finally {
      void server.stop()
    }
  })

  test('unreachable endpoint → EndpointUnreachable', async () => {
    // Bind a server to a free port, then stop it — the port is now closed.
    const probe = Bun.serve({ port: 0, fetch: () => new Response('x') })
    const closedUrl = probe.url.toString()
    await probe.stop()

    const error = await Effect.runPromise(
      Effect.flip(chat({ url: closedUrl, requests: [], stop: () => {} }, simpleRequest())),
    )
    expect(error._tag).toBe('EndpointUnreachable')
  })

  test('readAiEnv resolves a complete env record', async () => {
    const env = await Effect.runPromise(
      Bindings.readAiEnv({ NEBIUS_ENDPOINT_URL: 'https://ep.example.com', NEBIUS_ENDPOINT_AUTH_TOKEN: 'tok' }),
    )
    expect(env).toEqual({ NEBIUS_ENDPOINT_URL: 'https://ep.example.com', NEBIUS_ENDPOINT_AUTH_TOKEN: 'tok' })
  })

  test('readAiEnv fails with InvalidCredentials listing the missing names', async () => {
    const error = await Effect.runPromise(
      Effect.flip(Bindings.readAiEnv({ NEBIUS_ENDPOINT_AUTH_TOKEN: 'tok' })),
    )
    expect(error._tag).toBe('InvalidCredentials')
    if (error._tag === 'InvalidCredentials') {
      expect(error.missing).toEqual(['NEBIUS_ENDPOINT_URL'])
    }
  })

  test('ChatCompletionsHttp runtime side — guard pre-set, mocked host', async () => {
    const mock = startOpenAiMock()
    try {
      // Fold the deploy-time guard as the bundler does at build time: the
      // deploy-time branch (which needs a REAL running endpoint's attrs) is
      // skipped; the runtime side reads the provided WorkerEnvironment and
      // round-trips through the fetch client.
      const saved = globalThis.__ALCHEMY_RUNTIME__
      // oxlint-disable-next-line no-explicit-any — test harness: simulate the bundler fold
      ;(globalThis as any).__ALCHEMY_RUNTIME__ = true
      try {
        // An empty endpoint stand-in: the deploy-time branch that reads
        // `endpoint.publicEndpoints` is skipped by the `__ALCHEMY_RUNTIME__`
        // fold above, so no attrs are ever touched. The cast is required —
        // the parameter is an `Input<NebiusEndpoint>` and `{}` alone is not
        // assignable to it.
        const chat = await Effect.runPromise(
          (Bindings.ChatCompletions({} as unknown as NebiusEndpoint).pipe(
            Effect.provide(Bindings.ChatCompletionsHttp),
            Effect.provide(mockSelf({ Type: 'Cloudflare.Worker', LogicalId: 'MockHost' })),
            Effect.provide(
              Layer.succeed(WorkerEnvironment, {
                NEBIUS_ENDPOINT_URL: mock.url,
                NEBIUS_ENDPOINT_AUTH_TOKEN: 'layer-token',
              }),
            ),
          )),
        )
        const result = await Effect.runPromise(chat(simpleRequest()))
        expect(result.stream).toBe(false)
        if (result.stream === false) {
          expect(result.response.choices[0]?.message.content).toBe('mock reply')
        }
        // The layer wired the env through readAiEnv → the client sent the token.
        expect(mock.requests[0]?.authorization).toBe('Bearer layer-token')
      } finally {
        ;(globalThis as any).__ALCHEMY_RUNTIME__ = saved
      }
    } finally {
      mock.stop()
    }
  })

  test('ChatCompletionsHttp runtime side on an INSTANCE host reads process.env', async () => {
    const mock = startOpenAiMock()
    const saved = globalThis.__ALCHEMY_RUNTIME__
    ;(globalThis as any).__ALCHEMY_RUNTIME__ = true
    process.env.NEBIUS_ENDPOINT_URL = mock.url
    process.env.NEBIUS_ENDPOINT_AUTH_TOKEN = 'env-token'
    try {
      // No WorkerEnvironment provided — the instance host reads `process.env`
      // (the shipped env file populates it via systemd EnvironmentFile).
      const chat = await Effect.runPromise(
        (Bindings.ChatCompletions({} as unknown as NebiusEndpoint).pipe(
          Effect.provide(Bindings.ChatCompletionsHttp),
          Effect.provide(mockSelf({ Type: 'Nebius.compute.v1.Instance', LogicalId: 'MockInstance' })),
        )),
      )
      const result = await Effect.runPromise(chat(simpleRequest()))
      expect(result.stream).toBe(false)
      // The env came from process.env, not a WorkerEnvironment layer.
      expect(mock.requests[0]?.authorization).toBe('Bearer env-token')
    } finally {
      ;(globalThis as any).__ALCHEMY_RUNTIME__ = saved
      delete process.env.NEBIUS_ENDPOINT_URL
      delete process.env.NEBIUS_ENDPOINT_AUTH_TOKEN
    }
    mock.stop()
  })
})
