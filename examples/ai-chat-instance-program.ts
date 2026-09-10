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
import { ChatCompletionRequest } from '@fllstck/nebius-alchemy/resources/ai/v1/bindings.schema.ts'
import { NebiusInstance } from '@fllstck/nebius-alchemy/resources/compute/v1/instance.ts'

/** Must match the endpoint's `args` in the stack — vLLM rejects other models. */
const MODEL = 'Qwen/Qwen3-0.6B'
const DEFAULT_PROMPT = 'In one sentence, what is Nebius AI Cloud?'

export default NebiusInstance(
  'AiChatInstance',
  Effect.gen(function* () {
    // The VM never calls the Nebius API, but the constructor still VALIDATES
    // props — so the two ids the schema requires are read from the shipped env
    // (the stack passes them through `env`). Everything else is inert here: at
    // runtime no provider runs, so these values are never sent anywhere.
    const subnetId = yield* Effect.orDie(
      Config.string('AI_CHAT_SUBNET_ID').pipe(Config.withDefault('')),
    )
    const serviceAccountId = yield* Effect.orDie(
      Config.string('AI_CHAT_SA_ID').pipe(Config.withDefault('')),
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
    // The typed runtime client. `ChatCompletionsHttp` resolves the injected env
    // (NEBIUS_ENDPOINT_URL / NEBIUS_ENDPOINT_AUTH_TOKEN) on an instance host.
    const endpoint = yield* NebiusEndpoint.ref('llm')
    const chat = yield* ChatCompletions(endpoint).pipe(Effect.provide(ChatCompletionsHttp))

    return {
      // GET /?prompt=… → one chat completion through the binding.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest
        const prompt =
          new URL(request.url, 'http://localhost').searchParams.get('prompt') ?? DEFAULT_PROMPT

        const outcome = yield* Effect.result(
          chat(
            new ChatCompletionRequest({
              model: MODEL,
              messages: [{ role: 'user', content: prompt }],
              // Qwen3 is a REASONING model: it emits a `<think>…</think>` block
              // before the answer, so a small budget truncates mid-thought (the
              // verified run returned a cut-off `<think>` block). Raise this (or
              // ask for a directly-formatted answer) for longer replies.
              max_tokens: 128,
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

        if (outcome.success.stream !== false) {
          return yield* HttpServerResponse.json(
            { ok: false, error: 'streaming responses are not shown in this example' },
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
