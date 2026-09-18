/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The VM program for the `ai-chat-instance` example — the code that runs ON the
 * Nebius instance and answers with a real chat completion.
 *
 * ⚠️ This file is BUNDLED and executed on the VM; the CLI never runs it (a bundle
 * is not executed at deploy time). Two consequences:
 *
 *   1. The BINDING is registered by the stack (`examples/ai-chat-instance.ts`,
 *      which declares the same instance with an inline init Effect) — a bundle
 *      cannot do deploy work. Here we only *consume* it: the endpoint's managed
 *      https URL and bearer token arrive in the systemd `EnvironmentFile` the
 *      deploy shipped, and on an instance host `ChatCompletionsHttp` reads them
 *      from `process.env`.
 *   2. DEEP IMPORTS ONLY. `import * as Nebius from '@fllstck/nebius-alchemy'`
 *      would drag the whole provider surface (gRPC api-clients, protobuf
 *      schemas, rolldown/vite) into the bundle downloaded by the VM.
 *
 * `NebiusEndpoint.ref('llm')` is the handle the typed contract asks for. On an
 * instance the runtime client ignores it (URL + token come from the env), so a
 * reference is enough — nothing is deployed from this file.
 *
 * Usage (from the host that deployed the stack):
 *   curl "http://<instance-public-ip>:3000/?prompt=Say+hello+in+five+words"
 *   curl -N "http://<instance-public-ip>:3000/?prompt=Count+to+five&stream=1"
 *     → Server-Sent Events, one frame per chunk: `data: {"t":ms,"delta":"…"}`
 *       (verified on a VM: 122 frames arriving incrementally, then `{"done":true}`)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'

import { NebiusEndpoint } from '@fllstck/nebius-alchemy/resources/ai/v1/endpoint.ts'
import {
  ChatCompletions,
  ChatCompletionsHttp,
} from '@fllstck/nebius-alchemy/resources/ai/v1/bindings.ts'
import {
  ChatCompletionChunk,
  ChatCompletionRequest,
} from '@fllstck/nebius-alchemy/resources/ai/v1/bindings.schema.ts'
import { NebiusInstance } from '@fllstck/nebius-alchemy/resources/compute/v1/instance.ts'

/**
 * The served model's name. vLLM rejects a request whose `model` differs from the
 * container's `--model`; llama.cpp ignores the field. The stack ships the right
 * value as `AI_CHAT_MODEL` per endpoint variant.
 */
const DEFAULT_MODEL = 'Qwen/Qwen2.5-0.5B-Instruct'
const DEFAULT_PROMPT = 'In one sentence, what is Nebius AI Cloud?'

/**
 * `stream: true` — re-emit the typed chunks as Server-Sent Events, each carrying
 * the delta + milliseconds since the first chunk, so `curl -N` shows the tokens
 * ARRIVING (not one buffered blob). The binding decodes the endpoint's SSE into
 * typed `ChatCompletionChunk`s; here they go straight back out as SSE.
 */
const toSseStream = (chunks: ReadableStream<ChatCompletionChunk>): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const started = Date.now()
  return chunks.pipeThrough(
    new TransformStream<ChatCompletionChunk, Uint8Array>({
      transform(chunk, controller) {
        const delta = chunk.choices[0]?.delta.content
        if (delta) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ t: Date.now() - started, delta })}\n\n`),
          )
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, t: Date.now() - started })}\n\n`))
      },
    }),
  )
}

export default NebiusInstance(
  'AiChatInstance',
  Effect.gen(function* () {
    // The VM never calls the Nebius API, but the constructor still VALIDATES
    // props — so the two ids the schema requires are read from the shipped env
    // (the stack passes them through `env`). Everything else is inert here: at
    // runtime no provider runs, so these values are never sent anywhere.
    const subnetId = yield* Effect.orDie(
      Config.String('AI_CHAT_SUBNET_ID').pipe(Config.withDefault('')),
    )
    const serviceAccountId = yield* Effect.orDie(
      Config.String('AI_CHAT_SA_ID').pipe(Config.withDefault('')),
    )

    return {
      main: import.meta.url,
      port: 3000,
      serviceAccountId,
      resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
      bootDisk: {
        attachMode: 'READ_WRITE' as const,
        managedDisk: {
          name: 'boot-disk',
          // Nebius enforces a 64 GiB boot-disk floor and a blank disk has no OS
          // — cloud-init would never run. The family resolves to the latest
          // `ubuntu24.04-driverless` image at apply time.
          spec: {
            type: 'NETWORK_SSD' as const,
            sizeGibibytes: 64,
            sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
          },
        },
      },
      networkInterfaces: [{ subnetId, name: 'eth0', ipAddress: { allocationId: '' } }],
    }
  }),

  Effect.gen(function* () {
    // Which model to ask for. The stack ships `AI_CHAT_MODEL` in the instance
    // `env` so the two endpoint variants (llama.cpp / vLLM) stay in sync with
    // this request — vLLM rejects a mismatch, llama.cpp ignores the field.
    const model = yield* Effect.orDie(
      Config.String('AI_CHAT_MODEL').pipe(Config.withDefault(DEFAULT_MODEL)),
    )

    // The typed runtime client. `ChatCompletionsHttp` resolves the injected env
    // (NEBIUS_ENDPOINT_URL / NEBIUS_ENDPOINT_AUTH_TOKEN) on an instance host.
    const endpoint = yield* NebiusEndpoint.ref('llm')
    const chat = yield* ChatCompletions(endpoint).pipe(Effect.provide(ChatCompletionsHttp))

    return {
      // GET /?prompt=… → one chat completion through the binding.
      // GET /?prompt=…&stream=1 → the same call streamed back as SSE.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest
        const params = new URL(request.url, 'http://localhost').searchParams
        const prompt = params.get('prompt') ?? DEFAULT_PROMPT
        const streaming = params.get('stream') === '1'

        const outcome = yield* Effect.result(
          chat(
            new ChatCompletionRequest({
              model,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 128,
              ...(streaming ? { stream: true } : {}),
            }),
          ),
        )

        if (Result.isFailure(outcome)) {
          // `AiError` is a tagged union (EndpointNotRunning, EndpointUnauthorized,
          // EndpointRateLimited, …) — `String(error)` names the tag.
          return yield* HttpServerResponse.json(
            { ok: false, prompt, error: String(outcome.failure) },
            { status: 502 },
          )
        }

        if (streaming) {
          if (outcome.success.stream !== true) {
            return yield* HttpServerResponse.json(
              { ok: false, error: 'expected a streamed response' },
              { status: 501 },
            )
          }
          // `raw` passes a Web ReadableStream straight through to the runtime.
          return HttpServerResponse.raw(toSseStream(outcome.success.chunks), {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            },
          })
        }

        if (outcome.success.stream !== false) {
          return yield* HttpServerResponse.json(
            { ok: false, error: 'streaming responses need &stream=1' },
            { status: 501 },
          )
        }

        const completion = outcome.success.response
        return yield* HttpServerResponse.json({
          ok: true,
          prompt,
          model: completion.model,
          reply: completion.choices[0]?.message.content ?? null,
          usage: completion.usage ?? null,
        })
      }),
    }
  }),
)
