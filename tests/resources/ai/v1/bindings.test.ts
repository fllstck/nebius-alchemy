/**
 * M2 unit tests for the AI endpoint bindings (AI_BINDINGS.md).
 *
 * 1. Schema round-trips: request encode, response/chunk decode (untrusted
 *    input goes through Schema — the wire contract).
 * 2. SSE parser torture suite: framing across byte-chunk boundaries, CRLF,
 *    keepalive comments, metadata lines, multi-line data, `[DONE]`, trailing
 *    frame without separator, malformed JSON.
 */
import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Bindings from '../../../../modules/resources/ai/v1/bindings.ts'
import * as BindingsSchema from '../../../../modules/resources/ai/v1/bindings.schema.ts'

// ---------------------------------------------------------------------------
// Stream test helpers
// ---------------------------------------------------------------------------

/** Feed raw string chunks as bytes into a readable stream (chunk boundaries
 * are deliberately controllable — the parser must not care about them). */
const feedBytes = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })

/** Collect all values of a readable stream. */
const collect = async <A>(stream: ReadableStream<A>): Promise<A[]> => {
  const out: A[] = []
  const reader = stream.getReader()
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop — stream reads are inherently sequential
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

/** Collect the error a readable stream rejects with (undefined if it ends cleanly). */
const collectError = async (stream: ReadableStream<unknown>): Promise<unknown> => {
  const reader = stream.getReader()
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop — stream reads are inherently sequential
      const { done } = await reader.read()
      if (done) return undefined
    }
  } catch (error) {
    return error
  }
}

const sse = (chunks: readonly string[]) => feedBytes(chunks).pipeThrough(Bindings.parseSseData())
const chunks = (data: readonly string[]) =>
  feedBytes(data).pipeThrough(Bindings.parseSseData()).pipeThrough(Bindings.decodeChatChunks())

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe('bindings.schema', () => {
  test('ChatCompletionRequest encodes to the OpenAI JSON shape', () => {
    const request = new BindingsSchema.ChatCompletionRequest({
      model: 'my-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7,
    })
    const encoded = Schema.encodeSync(BindingsSchema.ChatCompletionRequest)(request)
    expect(encoded.model).toBe('my-model')
    expect(encoded.messages[0]).toEqual({ role: 'user', content: 'hello' })
    // Optional fields stay absent unless set — no spurious `stream: false`.
    expect(encoded.stream).toBeUndefined()
    expect(JSON.parse(JSON.stringify(encoded)).messages[0].role).toBe('user')
  })

  test('ChatCompletion decodes an OpenAI response', () => {
    const decoded = Schema.decodeUnknownSync(BindingsSchema.ChatCompletion)({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'my-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi there' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
    expect(decoded.choices[0]?.message.content).toBe('hi there')
    expect(decoded.choices[0]?.finish_reason).toBe('stop')
    expect(decoded.usage?.total_tokens).toBe(5)
  })

  test('ChatCompletionChunk decodes with absent and null finish_reason', () => {
    const mid = Schema.decodeUnknownSync(BindingsSchema.ChatCompletionChunk)({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'my-model',
      choices: [{ index: 0, delta: { content: 'Hel' } }],
    })
    expect(mid.choices[0]?.delta.content).toBe('Hel')
    expect(mid.choices[0]?.finish_reason).toBeUndefined()

    const last = Schema.decodeUnknownSync(BindingsSchema.ChatCompletionChunk)({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'my-model',
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    })
    expect(last.choices[0]?.delta.content).toBeUndefined()
    expect(last.choices[0]?.finish_reason).toBeNull()
  })

  test('ChatCompletionChunk decodes role-only deltas with content null', () => {
    const decoded = Schema.decodeUnknownSync(BindingsSchema.ChatCompletionChunk)({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'my-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: null } }],
    })
    expect(decoded.choices[0]?.delta.role).toBe('assistant')
    expect(decoded.choices[0]?.delta.content).toBeNull()
  })

  test('rejects non-chunk object types', () => {
    expect(() =>
      Schema.decodeUnknownSync(BindingsSchema.ChatCompletionChunk)({
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [],
      }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// SSE framing (parseSseData)
// ---------------------------------------------------------------------------

describe('parseSseData', () => {
  test('single event', async () => {
    const out = await collect(sse(['data: hello\n\n']))
    expect(out).toEqual(['hello'])
  })

  test('data payload split across byte chunks — no split-JSON corruption', async () => {
    const payload = 'data: {"id":"1","content":"hello world"}\n\n'
    // Split mid-payload: boundary inside the JSON, not at the separator.
    const cut = payload.indexOf('world')
    const out = await collect(sse([payload.slice(0, cut), payload.slice(cut)]))
    expect(out).toEqual(['{"id":"1","content":"hello world"}'])
  })

  test('frame split across multiple byte chunks', async () => {
    const out = await collect(sse(['data: one', '\n\ndata: tw', 'o\n\ndata: th', 'ree\n\n']))
    expect(out).toEqual(['one', 'two', 'three'])
  })

  test('multiple events in a single chunk', async () => {
    const out = await collect(sse(['data: a\n\ndata: b\n\ndata: c\n\n']))
    expect(out).toEqual(['a', 'b', 'c'])
  })

  test('CRLF line endings', async () => {
    const out = await collect(sse(['data: a\r\n\r\ndata: b\r\n\r\n']))
    expect(out).toEqual(['a', 'b'])
  })

  test('keepalive comment frames are skipped', async () => {
    const out = await collect(sse([': ping\n\ndata: a\n\n: still here\n\n']))
    expect(out).toEqual(['a'])
  })

  test('event/id/retry metadata lines are ignored, data still extracted', async () => {
    const out = await collect(sse(['event: message\nid: 42\nretry: 100\ndata: a\n\n']))
    expect(out).toEqual(['a'])
  })

  test('multi-line data joins with newline (SSE spec)', async () => {
    const out = await collect(sse(['data: line1\ndata: line2\n\n']))
    expect(out).toEqual(['line1\nline2'])
  })

  test('trailing frame without separator is emitted on flush', async () => {
    const out = await collect(sse(['data: a\n\ndata: b']))
    expect(out).toEqual(['a', 'b'])
  })

  test('no data lines → no output', async () => {
    const out = await collect(sse(['event: ping\n\n']))
    expect(out).toEqual([])
  })

  test('empty stream → no output', async () => {
    const out = await collect(sse([]))
    expect(out).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Chunk decoding (decodeChatChunks)
// ---------------------------------------------------------------------------

const CHUNK_JSON = '{"id":"x","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{"content":"Hel"}}]}'

describe('decodeChatChunks', () => {
  test('decodes valid chunk JSON', async () => {
    const out = await collect(chunks([`data: ${CHUNK_JSON}\n\n`]))
    expect(out).toHaveLength(1)
    expect(out[0]?.choices[0]?.delta.content).toBe('Hel')
  })

  test('[DONE] terminates without emitting', async () => {
    const out = await collect(chunks([`data: ${CHUNK_JSON}\n\n`, 'data: [DONE]\n\n', 'data: junk-after-done\n\n']))
    expect(out).toHaveLength(1)
  })

  test('malformed JSON errors the stream with MalformedStream', async () => {
    const error = await collectError(chunks(['data: {not json\n\n']))
    expect(error).toBeInstanceOf(Bindings.MalformedStream)
    if (error instanceof Bindings.MalformedStream) {
      expect(error._tag).toBe('MalformedStream')
    }
  })

  test('DONE_MARKER is exported', () => {
    expect(Bindings.DONE_MARKER).toBe('[DONE]')
  })
})

describe('errors', () => {
  test('MalformedStream is catchable by tag', async () => {
    const caught = await Effect.runPromise(
      Effect.fail(new Bindings.MalformedStream({ message: 'bad' })).pipe(
        Effect.catchTag('MalformedStream', (err) => Effect.succeed(`caught:${err.message}`)),
      ),
    )
    expect(caught).toBe('caught:bad')
  })
})
