/**
 * The AI bindings example Worker — Effect-native entry (inline implementation).
 *
 * This file IS the Worker: it declares an inference endpoint (plus its
 * network/subnet) and consumes the typed `ChatCompletions` runtime client.
 * The stack (`ai.bindings.ts`) imports this construct and `yield*`s it,
 * keeping the entry separate from the stack so the deployed bundle doesn't
 * drag in the provider/runtime machinery.
 *
 * ⚠️ Keep imports narrow: a namespace import of `@fllstck/nebius-alchemy`
 * (or `alchemy/Cloudflare`) drags the whole surface (providers, local
 * workerd runtime) into the worker bundle. Deep subpath imports let rolldown
 * tree-shake everything the handler doesn't use.
 */
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { NebiusEndpoint } from '@fllstck/nebius-alchemy/resources/ai/v1/endpoint.ts'
import {
  ChatCompletions,
  ChatCompletionsHttp,
} from '@fllstck/nebius-alchemy/resources/ai/v1/bindings.ts'
import { ChatCompletionRequest } from '@fllstck/nebius-alchemy/resources/ai/v1/bindings.schema.ts'
import { NebiusNetwork } from '@fllstck/nebius-alchemy/resources/vpc/v1/network.ts'
import { NebiusSubnet } from '@fllstck/nebius-alchemy/resources/vpc/v1/subnet.ts'

export default Cloudflare.Worker(
  'AiApi',
  // The entry file itself — bundling `import.meta.url` here is safe: this
  // module only imports the contracts + effect runtime, not the stack.
  { main: import.meta.url, build: { output: { minify: true } } },
  Effect.gen(function* () {
    // Networking for the endpoint (a VM it must live in a subnet).
    const network = yield* NebiusNetwork('Network', {})
    const subnet = yield* NebiusSubnet('Subnet', { networkId: network.id })

    // A minimal inference endpoint. Point `image`/`ports` at your model
    // server (vLLM/TGI/Ollama all speak the OpenAI HTTP API). Auth is
    // enabled with a bearer token — the binding injects it into the Worker
    // as a Cloudflare `secret_text` binding at deploy time.
    const endpoint = yield* NebiusEndpoint('llm', {
      image: 'vllm/vllm-openai:latest',
      platform: 'cpu-d3',
      preset: '4vcpu-16gb',
      subnetId: subnet.id,
      publicIp: true,
      preemptible: false,
      environmentVariables: [],
      ports: [{ containerPort: 8000, protocol: 'HTTP' }],
      volumes: [],
      disk: { type: 'NETWORK_SSD', sizeBytes: 10_737_418_240 },
      authToken: 'replace-with-a-real-token',
    })

    // The typed runtime client — derives the endpoint's public URL and token
    // at deploy time; `ChatCompletionsHttp` provides the implementation.
    const chat = yield* ChatCompletions(endpoint)

    return {
      // POST /  → run one chat completion against the endpoint.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest
        if (request.method !== 'POST') {
          return HttpServerResponse.text('send a POST to chat with this endpoint', { status: 405 })
        }

        const outcome = yield* Effect.exit(
          chat(
            new ChatCompletionRequest({
              model: 'my-model',
              messages: [{ role: 'user', content: 'Hello from the Worker!' }],
            }),
          ),
        )
        if (Exit.isFailure(outcome)) {
          return HttpServerResponse.text(`chat failed: ${String(outcome.cause)}`, { status: 500 })
        }

        // `stream: true` would return an SSE stream of typed chunks instead
        // (see AI_BINDINGS.md AD3) — this example uses the plain response.
        if (outcome.value.stream === false) {
          return HttpServerResponse.jsonUnsafe(outcome.value.response, { status: 200 })
        }
        return HttpServerResponse.text('streaming responses are not shown in this example', { status: 501 })
      }),
    }
  }).pipe(
    // The binding implementation — the AWS arm (`*FunctionHttp`) lands later.
    Effect.provide(ChatCompletionsHttp),
  ),
)
