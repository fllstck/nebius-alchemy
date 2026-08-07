/**
 * M2 — OpenAI-compatible wire schemas for the AI endpoint bindings
 * (AI_BINDINGS.md AD3).
 *
 * The endpoint container is user-deployed (vLLM/TGI/Ollama-style servers)
 * speaking the OpenAI HTTP API. These classes are the wire contract:
 * requests are encoded by the client, responses/chunks are decoded —
 * untrusted data goes through Schema, never manual parsing.
 *
 * v1 scope: string-only message content, no tool/function calls, no
 * multimodal content arrays. Endpoint-specific sampling params (vLLM's
 * `repetition_penalty`, `top_k`, …) can be added as request fields later.
 */
import * as Schema from 'effect/Schema'

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

/** OpenAI-compatible chat roles. */
export const ChatRole = Schema.Union([
  Schema.Literal('system'),
  Schema.Literal('developer'),
  Schema.Literal('user'),
  Schema.Literal('assistant'),
  Schema.Literal('tool'),
])

/** One chat message. `content` is a plain string in v1. */
export class ChatMessage extends Schema.Class<ChatMessage>('ChatMessage')({
  role: ChatRole,
  content: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Chat completion request (encode-oriented — the client sends this)
// ---------------------------------------------------------------------------

/**
 * `POST /v1/chat/completions` request body.
 *
 * `stream: true` switches the response to an SSE stream of
 * {@link ChatCompletionChunk}s — see the binding's result union.
 */
export class ChatCompletionRequest extends Schema.Class<ChatCompletionRequest>('ChatCompletionRequest')({
  model: Schema.String,
  messages: Schema.Array(ChatMessage),
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  max_tokens: Schema.optional(Schema.Int),
  stop: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  stream: Schema.optional(Schema.Boolean),
}) {}

// ---------------------------------------------------------------------------
// Chat completion response (non-stream, decode-oriented — untrusted input)
// ---------------------------------------------------------------------------

/** Token usage reported by the endpoint. */
export class ChatCompletionUsage extends Schema.Class<ChatCompletionUsage>('ChatCompletionUsage')({
  prompt_tokens: Schema.Int,
  completion_tokens: Schema.Int,
  total_tokens: Schema.Int,
}) {}

/** `finish_reason` values seen from OpenAI-compatible servers. */
export const FinishReason = Schema.Union([
  Schema.Literal('stop'),
  Schema.Literal('length'),
  Schema.Literal('content_filter'),
  Schema.Literal('tool_calls'),
  Schema.Literal('function_call'),
])

export class ChatCompletionChoice extends Schema.Class<ChatCompletionChoice>('ChatCompletionChoice')({
  index: Schema.Int,
  message: ChatMessage,
  /** `null` when the server omits the reason (rare; OpenAI sends it). */
  finish_reason: Schema.NullOr(FinishReason),
}) {}

/** Full (non-streamed) chat completion response. */
export class ChatCompletion extends Schema.Class<ChatCompletion>('ChatCompletion')({
  id: Schema.String,
  object: Schema.Literal('chat.completion'),
  created: Schema.Finite,
  model: Schema.String,
  choices: Schema.Array(ChatCompletionChoice),
  usage: Schema.optional(ChatCompletionUsage),
}) {}

// ---------------------------------------------------------------------------
// Chat completion chunk (SSE stream, decode-oriented — untrusted input)
// ---------------------------------------------------------------------------

/** Incremental delta inside one streamed chunk. */
export class ChatCompletionChunkDelta extends Schema.Class<ChatCompletionChunkDelta>('ChatCompletionChunkDelta')({
  role: Schema.optional(ChatRole),
  /** `null` for role-only deltas (some servers emit `content: null`). */
  content: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

export class ChatCompletionChunkChoice extends Schema.Class<ChatCompletionChunkChoice>('ChatCompletionChunkChoice')({
  index: Schema.Int,
  delta: ChatCompletionChunkDelta,
  /** `null` on the final chunk; absent on intermediate ones. */
  finish_reason: Schema.optional(Schema.NullOr(FinishReason)),
}) {}

/** One SSE event in a `stream: true` response. */
export class ChatCompletionChunk extends Schema.Class<ChatCompletionChunk>('ChatCompletionChunk')({
  id: Schema.String,
  object: Schema.Literal('chat.completion.chunk'),
  created: Schema.Finite,
  model: Schema.String,
  choices: Schema.Array(ChatCompletionChunkChoice),
}) {}
