/**
 * M2 — SSE parser for the AI endpoint bindings (AI_BINDINGS.md AD3).
 *
 * The streaming half of `ChatCompletions`: `fetch` bodies are raw bytes, so
 * the binding decodes them into typed `ChatCompletionChunk`s. Two stages:
 *
 *   response.body.pipeThrough(parseSseData()).pipeThrough(decodeChatChunks())
 *
 * 1. `parseSseData` — SSE framing → `data:` payload strings (blank-line
 *    separators, CRLF tolerance, keepalive comments, metadata lines).
 * 2. `decodeChatChunks` — `data:` payloads → Schema-validated chunks;
 *    `[DONE]` ends the stream; malformed JSON errors with
 *    {@link MalformedStream}.
 *
 * ⚠️ BUNDLE SAFETY (AD8): this module is statically workerd-safe — native
 * `TransformStream` + `TextDecoder` only, no Node Buffer, no gRPC, no dynamic
 * import. (Native streams, not Effect `Stream`: the consumer is a Worker's
 * `fetch` handler on a native `ReadableStream`, and piping through native
 * `TransformStream`s adds zero runtime machinery to the bundle.)
 */
import * as Schema from 'effect/Schema'
import { ChatCompletionChunk } from './bindings.schema.ts'

/** The OpenAI SSE terminator event payload. */
export const DONE_MARKER = '[DONE]'

/** JSON-string → {@link ChatCompletionChunk} (fromJsonString: JSON.parse + Schema decode). */
const decodeChunk = Schema.fromJsonString(ChatCompletionChunk)

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Mid-stream failure: bad SSE framing or a non-JSON event payload. */
export class MalformedStream extends Schema.TaggedErrorClass<MalformedStream>()('MalformedStream', {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// SSE framing helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Split raw SSE text into complete frames — a frame is terminated by a blank
 * line (`\n\n` or `\r\n\r\n`). The final element is the incomplete remainder
 * (kept in the buffer until more bytes arrive or the stream flushes).
 *
 * @internal
 */
export const splitFrames = (buffer: string): { frames: readonly string[]; rest: string } => {
  const parts = buffer.split(/\r?\n\r?\n/)
  return { frames: parts.slice(0, -1), rest: parts[parts.length - 1] ?? '' }
}

/**
 * Extract the `data:` payload of one SSE frame, or `null` when the frame
 * carries no data line (keepalive comments, `event:`/`id:`/`retry:` metadata,
 * blank frames). Multiple `data:` lines join with `\n` per the SSE spec; a
 * single leading space after `data:` is stripped.
 *
 * @internal
 */
export const frameData = (frame: string): string | null => {
  const dataLines: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
    // event:/id:/retry: metadata lines are ignored (v1)
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null
}

// ---------------------------------------------------------------------------
// TransformStreams
// ---------------------------------------------------------------------------

/**
 * Stage 1 — parse an SSE byte stream into `data:` payload strings.
 *
 * Chunk boundaries are irrelevant: bytes accumulate in a string buffer and
 * complete frames are emitted as they appear (this is where the classic
 * "JSON split across TCP chunks" bug lives — handled by buffering until the
 * blank-line separator). A final frame without a trailing separator is
 * emitted on flush, when the source ends.
 */
export const parseSseData = (): TransformStream<Uint8Array, string> => {
  const decoder = new TextDecoder()
  let buffer = ''
  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const { frames, rest } = splitFrames(buffer)
      buffer = rest
      for (const frame of frames) {
        const data = frameData(frame)
        if (data !== null) controller.enqueue(data)
      }
    },
    flush(controller) {
      // Flush the decoder, then emit any final frame that arrived without a
      // trailing separator (the source ended mid-event).
      buffer += decoder.decode()
      const { frames, rest } = splitFrames(buffer)
      for (const frame of frames) {
        const data = frameData(frame)
        if (data !== null) controller.enqueue(data)
      }
      const tail = frameData(rest)
      if (tail !== null) controller.enqueue(tail)
    },
  })
}

/**
 * Stage 2 — decode `data:` payload strings into typed chunks.
 *
 * `[DONE]` ends the stream: the server normally closes the connection right
 * after, and the flag additionally guards keepalive-after-`[DONE]` servers
 * from emitting junk. Malformed JSON errors the stream with
 * {@link MalformedStream} — a corrupt event means the endpoint is
 * misbehaving, so the consumer fails loudly rather than skipping.
 */
export const decodeChatChunks = (): TransformStream<string, ChatCompletionChunk> => {
  let done = false
  return new TransformStream<string, ChatCompletionChunk>({
    transform(data, controller) {
      if (done) return
      if (data === DONE_MARKER) {
        done = true
        return
      }
      try {
        controller.enqueue(Schema.decodeUnknownSync(decodeChunk)(data))
      } catch (error) {
        controller.error(
          new MalformedStream({
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    },
  })
}
