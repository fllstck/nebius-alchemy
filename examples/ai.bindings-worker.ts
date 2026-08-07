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

    // The canonical Nebius LLM endpoint (from the official Serverless AI
    // cookbook's Qwen3-0.6B template): vLLM (OpenAI-compatible) serving
    // Qwen/Qwen3-0.6B on an L40S GPU. Requires an eu-north1 project — the
    // account's GPU/VM quota lives there and `gpu-l40s-a` doesn't exist in
    // eu-west1. Auth is enabled with a bearer token — the binding injects it
    // into the Worker as a Cloudflare `secret_text` binding at deploy time.
    const endpoint = yield* NebiusEndpoint('llm', {
      image: 'vllm/vllm-openai:v0.19.1',
      // The template's exact command, split per the cookbook's CLI convention
      // (--container-command / --args), plus `--enforce-eager`: vLLM's first
      // start on a fresh VM compiles kernels with torch.compile and captures
      // CUDA graphs across 33 batch sizes — multi-minute on a cold start.
      // `--enforce-eager` disables both (docs.vllm.ai: "Turn off torch.compile
      // and CUDAGraphs") for fast startup at slightly higher per-token cost —
      // right for a demo; drop it for max production throughput. For faster
      // model downloads, add `HF_TOKEN` to environmentVariables (unauthenticated
      // HF pulls are rate-limited).
      containerCommand: 'python3',
      args: '-m vllm.entrypoints.openai.api_server --model Qwen/Qwen3-0.6B --host 0.0.0.0 --port 8000 --enforce-eager',
      platform: 'gpu-l40s-a',
      preset: '1gpu-8vcpu-32gb',
      subnetId: subnet.id,
      publicIp: true,
      preemptible: true,
      environmentVariables: [],
      ports: [{ containerPort: 8000, protocol: 'HTTP' }],
      volumes: [],
      disk: { type: 'NETWORK_SSD', sizeBytes: 536_870_912_000 }, // 500 GiB (template value)
      shmSizeBytes: 17_179_869_184, // 16 GiB (vLLM needs large shared memory)
      authToken: 'replace-with-a-real-token',
    })
    // ── Wiring-validation alternative (no GPU / quota needed) ─────────────
    // nginx on cpu-d3 (the repo's integration-test combo): fast and cheap,
    // proves the full binding chain (endpoint RUNNING → public URL wired →
    // Worker env → runtime client). Not OpenAI-compatible — a chat call
    // returns the binding's EndpointNotFound (404).
    // const endpoint = yield* NebiusEndpoint('llm', {
    //   image: 'nginx:alpine',
    //   platform: 'cpu-d3',
    //   preset: '4vcpu-16gb',
    //   subnetId: subnet.id,
    //   publicIp: true,
    //   preemptible: false,
    //   environmentVariables: [],
    //   ports: [{ containerPort: 80, protocol: 'HTTP' }],
    //   volumes: [],
    //   disk: { type: 'NETWORK_SSD', sizeBytes: 10_737_418_240 },
    //   authToken: 'replace-with-a-real-token',
    // })

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
              // Must match the container's --model (vLLM rejects others).
              model: 'Qwen/Qwen3-0.6B',
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
