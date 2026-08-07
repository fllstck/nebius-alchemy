/**
 * Local OpenAI-compatible mock server (AD4 — mock-first testing).
 *
 * Serves `POST /v1/chat/completions` with scripted behavior: a JSON response
 * (non-stream), an SSE stream (frames fed exactly as given — tests can be
 * deliberately awkward), or an error status with an OpenAI-style error body.
 * Records every request for assertions (method, path, Authorization header,
 * parsed JSON body).
 *
 * @internal — test helper only.
 */
export interface OpenAiMockRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body: unknown
}

export interface OpenAiMockOptions {
  /** Scripted SSE data payloads (framing added by the mock) — enables stream mode. */
  readonly streamFrames?: readonly string[]
  /** JSON response for non-stream mode (default: a plausible completion). */
  readonly response?: unknown
  /** HTTP status for error mode (default 200). */
  readonly status?: number
  /** OpenAI-style error body: `{ error: { message, type, code } }`. */
  readonly errorBody?: unknown
}

const DEFAULT_RESPONSE = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'mock-model',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'mock reply' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
}

const DEFAULT_ERROR_BODY = { error: { message: 'mock error', type: 'mock_error', code: 'mock_code' } }

/** A realistic streaming response: role delta → two content deltas → finish. */
export const defaultStreamFrames = (): readonly string[] => [
  '{"id":"x","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
  '{"id":"x","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{"content":"Hel"}}]}',
  '{"id":"x","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{"content":"lo"}}]}',
  '{"id":"x","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '[DONE]',
]

export const startOpenAiMock = (options: OpenAiMockOptions = {}): {
  readonly url: string
  readonly requests: OpenAiMockRequest[]
  readonly stop: () => void
} => {
  const requests: OpenAiMockRequest[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname !== '/v1/chat/completions') {
        return new Response('not found', { status: 404 })
      }

      const text = await request.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        body,
      })

      if (options.status !== undefined && options.status >= 400) {
        return Response.json(options.errorBody ?? DEFAULT_ERROR_BODY, { status: options.status })
      }
      if (options.streamFrames !== undefined) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            for (const frame of options.streamFrames ?? []) {
              controller.enqueue(encoder.encode(`data: ${frame}\n\n`))
            }
            controller.close()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      return Response.json(options.response ?? DEFAULT_RESPONSE)
    },
  })
  return { url: server.url.toString(), requests, stop: () => void server.stop() }
}
