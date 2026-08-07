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
import * as Binding from 'alchemy/Binding'
import * as Output from 'alchemy/Output'
import { Worker, WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as BindHost from '../../shared/bind-host.ts'
import type { NebiusEndpoint } from './endpoint.ts'
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from './bindings.schema.ts'

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

/** The endpoint has no public endpoint — it must be RUNNING at deploy time (AD7). */
export class EndpointNotRunning extends Schema.TaggedErrorClass<EndpointNotRunning>()('EndpointNotRunning', {
  message: Schema.String,
}) {}

/** Required env bindings are missing at runtime (deploy-time wiring failure). */
export class InvalidCredentials extends Schema.TaggedErrorClass<InvalidCredentials>()('InvalidCredentials', {
  missing: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** The endpoint rejected the auth token (HTTP 401). */
export class EndpointUnauthorized extends Schema.TaggedErrorClass<EndpointUnauthorized>()('EndpointUnauthorized', {
  message: Schema.String,
}) {}

/** The requested resource or model does not exist (HTTP 404). */
export class EndpointNotFound extends Schema.TaggedErrorClass<EndpointNotFound>()('EndpointNotFound', {
  message: Schema.String,
}) {}

/** The endpoint is rate-limiting requests (HTTP 429). */
export class EndpointRateLimited extends Schema.TaggedErrorClass<EndpointRateLimited>()('EndpointRateLimited', {
  message: Schema.String,
}) {}

/** Any other endpoint failure, with the upstream error body preserved. */
export class EndpointError extends Schema.TaggedErrorClass<EndpointError>()('EndpointError', {
  statusCode: Schema.optional(Schema.Finite),
  type: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

/** The endpoint could not be reached (network failure). */
export class EndpointUnreachable extends Schema.TaggedErrorClass<EndpointUnreachable>()('EndpointUnreachable', {
  message: Schema.String,
}) {}

/** The shared error channel for AI endpoint bindings (AD5). */
export type AiError =
  | EndpointNotRunning
  | InvalidCredentials
  | EndpointUnauthorized
  | EndpointNotFound
  | EndpointRateLimited
  | EndpointError
  | EndpointUnreachable
  | MalformedStream

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

// ---------------------------------------------------------------------------
// Runtime env (M3)
// ---------------------------------------------------------------------------

const AI_ENV_NAMES = ['NEBIUS_ENDPOINT_URL', 'NEBIUS_ENDPOINT_AUTH_TOKEN'] as const

/** Literal-keyed env record — keeps property access `string` (noUncheckedIndexedAccess). */
export type AiEnv = Record<(typeof AI_ENV_NAMES)[number], string>

/**
 * Resolve the injected endpoint env values, failing with
 * {@link InvalidCredentials} if any are absent. The token is `''` when the
 * endpoint has auth disabled — only the URL must be non-empty.
 */
export const readAiEnv = Effect.fn('readAiEnv')(function* (
  env: Readonly<Record<string, unknown>>,
): Effect.fn.Return<AiEnv, InvalidCredentials> {
  const missing = AI_ENV_NAMES.filter((name) => typeof env[name] !== 'string')
  if (missing.length > 0) {
    return yield* new InvalidCredentials({
      missing: [...missing],
      message: `Missing Nebius AI endpoint env bindings: ${missing.join(', ')}. Did the binding's deploy-time wiring run?`,
    })
  }
  return {
    NEBIUS_ENDPOINT_URL: env.NEBIUS_ENDPOINT_URL as string,
    NEBIUS_ENDPOINT_AUTH_TOKEN: env.NEBIUS_ENDPOINT_AUTH_TOKEN as string,
  }
})

// ---------------------------------------------------------------------------
// Runtime client (M3)
// ---------------------------------------------------------------------------

/** The result of a chat completion call — the request's `stream` flag selects the branch. */
export type ChatCompletionsResult =
  | { readonly stream: true; readonly chunks: ReadableStream<ChatCompletionChunk> }
  | { readonly stream: false; readonly response: ChatCompletion }

/** The OpenAI error body shape `{ error: { message, type, code } }`. */
const ErrorBodySchema = Schema.Struct({
  error: Schema.Struct({
    message: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    code: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  }),
})

const decodeErrorBody = Schema.fromJsonString(ErrorBodySchema)

export interface ErrorBodyInfo {
  readonly message: string
  readonly type?: string
  readonly code?: string
}

/**
 * Parse an OpenAI-style error body from the response text. Falls back to the
 * raw text when the body isn't the expected shape (e.g. an HTML error page).
 */
export const parseErrorBody = (text: string): ErrorBodyInfo => {
  try {
    const { error } = Schema.decodeUnknownSync(decodeErrorBody)(text)
    return {
      message: error.message ?? text,
      type: error.type,
      code: error.code === undefined ? undefined : String(error.code),
    }
  } catch {
    return { message: text }
  }
}

/** Map an HTTP error status + body to the tagged {@link AiError} union (AD5). */
export const toAiError = (status: number, text: string): AiError => {
  const { message, type, code } = parseErrorBody(text)
  switch (status) {
    case 401:
      return new EndpointUnauthorized({ message })
    case 404:
      return new EndpointNotFound({ message })
    case 429:
      return new EndpointRateLimited({ message })
    default:
      return new EndpointError({ statusCode: status, type, code, message })
  }
}

/**
 * The chat completions operation over the OpenAI-compatible HTTP API.
 *
 * `request.stream === true` returns an SSE stream of typed chunks (the M2
 * parser stages); otherwise the full {@link ChatCompletion} response.
 *
 * @param values — resolved env (see {@link readAiEnv}); the auth token is
 *   sent as `Authorization: Bearer` only when non-empty.
 */
export const chatCompletions = (values: AiEnv) =>
  Effect.fn('Nebius.ai.Endpoint.ChatCompletions')(function* (
    request: ChatCompletionRequest,
  ): Effect.fn.Return<ChatCompletionsResult, AiError> {
    if (values.NEBIUS_ENDPOINT_URL === '') {
      // Belt-and-braces for the AD7 fail-fast: the deploy-time evaluation
      // fails when the endpoint has no public endpoint; if an empty URL still
      // reaches the worker, fail the call with the same tagged error.
      return yield* new EndpointNotRunning({
        message: 'NEBIUS_ENDPOINT_URL is empty — the endpoint had no public endpoint at deploy time (was it RUNNING?)',
      })
    }
    const url = new URL('/v1/chat/completions', values.NEBIUS_ENDPOINT_URL)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (values.NEBIUS_ENDPOINT_AUTH_TOKEN !== '') {
      headers['authorization'] = `Bearer ${values.NEBIUS_ENDPOINT_AUTH_TOKEN}`
    }

    const encoded = yield* Schema.encodeEffect(ChatCompletionRequest)(request).pipe(
      Effect.mapError(
        () => new EndpointError({ message: 'Invalid chat completion request', code: 'InvalidRequest' }),
      ),
    )
    const body = JSON.stringify(encoded)

    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { method: 'POST', headers, body }),
      catch: (e) => new EndpointUnreachable({ message: e instanceof Error ? e.message : String(e) }),
    })

    if (!response.ok) {
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => new EndpointUnreachable({ message: 'Failed to read the error response body' }),
      })
      return yield* toAiError(response.status, text)
    }

    if (request.stream === true) {
      // 2xx streaming response: pipe the SSE bytes through the M2 parser
      // stages. (`body` is never null on a real 2xx; the cast satisfies the
      // fetch typings.)
      return {
        stream: true as const,
        chunks: (response.body as ReadableStream<Uint8Array>)
          .pipeThrough(parseSseData())
          .pipeThrough(decodeChatChunks()),
      }
    }

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new EndpointUnreachable({ message: 'Failed to read the response body' }),
    })
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ChatCompletion))(text).pipe(
      Effect.mapError(
        () => new EndpointError({ statusCode: response.status, message: 'Invalid response body', code: 'InvalidResponse' }),
      ),
    )
    return { stream: false as const, response: decoded }
  })

// ---------------------------------------------------------------------------
// Deploy-time env derivation + contract + layer (M4)
// ---------------------------------------------------------------------------

/** Pure: the endpoint's first public endpoint, or `null` when it is not RUNNING (AD7). */
export const publicEndpointUrl = (publicEndpoints: readonly string[]): string | null =>
  publicEndpoints[0] ?? null

/** Pure: the `authToken` attribute → env value (`''` when auth is disabled). */
export const tokenToEnv = (token: string | undefined): string => token ?? ''

/**
 * The endpoint env values injected into the Worker (AD6). Outputs resolve at
 * apply time: the URL is the endpoint's first public endpoint — empty means
 * the endpoint is not RUNNING and the deploy fails with
 * {@link EndpointNotRunning} (AD7). The token is Redacted → deployed as a
 * Cloudflare `secret_text` binding.
 */
const endpointToEnv = (endpoint: NebiusEndpoint): Record<string, BindHost.EnvValue> => ({
  NEBIUS_ENDPOINT_URL: Output.mapEffect((eps: readonly string[]): Effect.Effect<string, never, never> => {
    const first = publicEndpointUrl(eps)
    if (first !== null) return Effect.succeed(first)
    // The failure is real and intended — fail the deploy at apply time (AD7) —
    // but the seam types the failure channel as `never`. Encapsulated cast,
    // same spirit as `unrequiring` in `host-identity.ts`.
    return Effect.fail(
      new EndpointNotRunning({
        message: `Endpoint ${endpoint.LogicalId} has no public endpoint yet — it must be RUNNING at deploy time`,
      }),
    ) as unknown as Effect.Effect<string, never, never>
  })(endpoint.publicEndpoints),
  NEBIUS_ENDPOINT_AUTH_TOKEN: Output.map((token: string | undefined) =>
    Redacted.make(tokenToEnv(token)),
  )(endpoint.authToken),
})

/**
 * ChatCompletions — typed OpenAI-compatible chat calls against a deployed
 * `Nebius.ai.Endpoint` (Cloudflare Worker host: deploy-time URL + token env
 * wiring, fetch client at runtime).
 *
 * Contract tag: `Nebius.ai.v1.Endpoint.ChatCompletions` (parallel to
 * `Nebius.storage.v1.Bucket.GetObject`).
 */
export interface ChatCompletions extends Binding.Service<
  ChatCompletions,
  'Nebius.ai.v1.Endpoint.ChatCompletions',
  (endpoint: NebiusEndpoint) => Effect.Effect<
    (request: ChatCompletionRequest) => Effect.Effect<ChatCompletionsResult, AiError>
  >
> {}

export const ChatCompletions = Binding.Service<ChatCompletions>('Nebius.ai.v1.Endpoint.ChatCompletions')

/**
 * ChatCompletionsHttp — the Cloudflare Worker implementation layer.
 *
 * Deploy-time (CLI): injects `NEBIUS_ENDPOINT_URL` + `NEBIUS_ENDPOINT_AUTH_TOKEN`
 * into the Worker env — once per host (registerEnvOnce). No host identity, no
 * AccessPermit, no gRPC (AD8): endpoint auth is a bearer token, so the module
 * is statically workerd-safe — no dynamic import, the bundler has nothing to
 * DCE.
 *
 * Runtime (deployed Worker / `alchemy dev`): reads the injected env off
 * `WorkerEnvironment` and delegates to the fetch client.
 */
export const ChatCompletionsHttp = Layer.effect(
  ChatCompletions,
  Effect.gen(function* () {
    const host = yield* Worker
    const env = yield* WorkerEnvironment

    return Effect.fn(function* (
      endpoint: NebiusEndpoint,
    ): Effect.fn.Return<
      (request: ChatCompletionRequest) => Effect.Effect<ChatCompletionsResult, AiError>
    > {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* BindHost.registerEnvOnce(
          host,
          'Nebius.ai.v1.Endpoint.ChatCompletions',
          endpointToEnv(endpoint),
        )
      }

      // Runtime: resolve env per call — the client is stateless, no memoization
      // needed. The request span comes from the inner `Effect.fn`.
      return (request: ChatCompletionRequest) =>
        readAiEnv(env).pipe(Effect.flatMap((values) => chatCompletions(values)(request)))
    })
  }),
)
