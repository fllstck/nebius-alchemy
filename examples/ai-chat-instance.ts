/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AI chat on a Nebius INSTANCE — `ChatCompletions` binding + real GPU endpoint
 *
 * The instance-host counterpart of `ai.bindings.ts` (which targets a Cloudflare
 * Worker). One stack deploys:
 *
 *   1. a **GPU vLLM endpoint** (Qwen3-0.6B on an L40S, OpenAI-compatible), and
 *   2. a **hosted instance** whose program (`ai-chat-instance-program.ts`) is
 *      bundled, shipped to an S3 assets bucket, fetched and served by systemd —
 *      and which answers `GET /?prompt=…` with a real chat completion.
 *
 * The interesting difference from the Worker example: a bundle is NEVER executed
 * by the CLI, so the binding must be registered on the DEPLOY side. That is the
 * inline init Effect on the instance below — it runs at plan/deploy (where the
 * instance is its own `Self` host and the endpoint's attributes are resolvable)
 * and its env lands in the systemd EnvironmentFile the VM reads at runtime. The
 * program file only consumes it.
 *
 * ⚠️ BILLABLE: a GPU VM (endpoint) *and* a CPU VM (instance) run until you
 * destroy the stack. **This file defaults to the CHEAP configuration**: a
 * CPU-only endpoint serving a 0.5B model with llama.cpp (no GPU, 64 GiB disk,
 * no shared memory) — a real chat completion for a fraction of the cost. The
 * production-shaped GPU configuration (vLLM on an L40S, as used by
 * `ai.bindings.ts`) is kept below as a commented block; the two differ ONLY in
 * the endpoint and the served model name.
 *
 * Cost knobs, in order of impact:
 *   1. GPU → CPU        this example: an L40S + 500 GiB + 16 GiB shm is
 *                       replaced by `cpu-d3` + 64 GiB. Also removes the ~10 GB
 *                       vLLM image pull and the multi-minute CUDA warmup.
 *   2. Model size       `Qwen2.5-0.5B-Instruct` Q4_K_M is ~0.4 GB (vs a 7B-class
 *                       model's ~4 GB) → faster container start, fewer tokens.
 *                       Prefer a NON-reasoning instruct model for demos: Qwen3
 *                       emits a `<think>` block first, which truncates at low
 *                       `max_tokens`.
 *   3. `preemptible`    the GPU variant below sets `true` (cheaper, may be
 *                       reclaimed). The CPU platform REJECTS it
 *                       (`3 INVALID_ARGUMENT: Preemptible is invalid`), so this
 *                       config uses `false`. The instance stays on-demand so a
 *                       demo is not interrupted mid-flight.
 *   4. Instance size    `cpu-d3`/`4vcpu-16gb` is the smallest preset this repo
 *                       has verified; the boot disk uses the 64 GiB floor.
 *
 * Verified 2026-09-10 (the CPU configuration below, as written): deploy 341 s for
 * 19 resources; the first `curl` returned a real completion
 * (`{"reply":"Hello! How may I help you?","usage":{"completion_tokens":9,…}}`);
 * `&stream=1` delivered 36 SSE frames incrementally; destroy took 192 s. Note
 * llama.cpp echoes its own GGUF name in `model` (it IGNORES the requested one),
 * while vLLM validates it — that is why the model name is an env knob.
 *
 * Usage:
 *   NEBIUS_API_KEY=… NEBIUS_TENANT_ID=… NEBIUS_PROJECT_ID=… \
 *     bun alchemy deploy examples/ai-chat-instance.ts --yes
 *
 *   # the stack prints nothing useful about networking — the instance's public
 *   # IP is only in the live status, so read it back with the CLI:
 *   IP=$(nebius compute instance get <instance-id> --format json \
 *         | jq -r '.status.network_interfaces[0].public_ip_address.address' | cut -d/ -f1)
 *   curl "http://$IP:3000/?prompt=Say+hello+in+five+words"
 *   curl -N "http://$IP:3000/?prompt=Count+to+five&stream=1"   # SSE
 *
 *   bun alchemy destroy examples/ai-chat-instance.ts --yes   # stops the billing
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Stack, localState } from 'alchemy'

import * as Nebius from '@fllstck/nebius-alchemy'

/** The served model's name — vLLM validates it, llama.cpp ignores it. */
const SERVED_MODEL = 'Qwen/Qwen2.5-0.5B-Instruct'

const REGION = process.env.NEBIUS_REGION ?? 'eu-north1'
const PROGRAM_MAIN = new URL('./ai-chat-instance-program.ts', import.meta.url).href

export default Stack(
  'AiChatInstance',
  {
    providers: Layer.mergeAll(Nebius.providers()),
    state: localState(),
  },
  Effect.gen(function* () {
    // ── Networking for both VMs ─────────────────────────────────────────────
    const network = yield* Nebius.vpc.Network('AiChat-Network', {})
    const subnet = yield* Nebius.vpc.Subnet('AiChat-Subnet', { networkId: network.id })

    // ── The instance's identity + firewall ──────────────────────────────────
    const sa = yield* Nebius.iam.ServiceAccount('AiChat-SA', {
      description: 'hosted AI chat runtime',
    })
    const sg = yield* Nebius.vpc.SecurityGroup('AiChat-SG', { networkId: network.id })
    yield* Nebius.vpc.SecurityRule('AiChat-SG-Ingress', {
      parentId: sg.id,
      direction: 'INGRESS',
      protocol: 'TCP',
      access: 'ALLOW',
      ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
    })
    // The custom SG replaces the default one, which has no egress rules — the VM
    // needs outbound HTTPS for the bun install, the S3 bundle fetch and the
    // endpoint call.
    yield* Nebius.vpc.SecurityRule('AiChat-SG-Egress', {
      parentId: sg.id,
      direction: 'EGRESS',
      protocol: 'ANY',
      access: 'ALLOW',
      egress: { destinationCidrs: ['0.0.0.0/0'] },
    })

    // ── The model server: OpenAI-compatible, CPU-only, tiny model ────────────
    // llama.cpp's server is a ~0.5 GB image that pulls a ~0.4 GB GGUF at start —
    // no GPU, no CUDA warmup, so a demo is up in minutes on the cheapest preset.
    // The binding derives its URL + bearer token from this resource's attributes.
    const endpoint = yield* Nebius.ai.Endpoint('llm', {
      image: 'ghcr.io/ggml-org/llama.cpp:server',
      containerCommand: '/app/llama-server',
      args: `-hf ${SERVED_MODEL}-GGUF:Q4_K_M --host 0.0.0.0 --port 8080`,
      platform: 'cpu-d3',
      preset: '4vcpu-16gb',
      subnetId: subnet.id,
      publicIp: true,
      // ⚠️ The API rejects `preemptible: true` on this CPU platform
      // (`3 INVALID_ARGUMENT: Preemptible is invalid`); it is accepted for the
      // GPU variant below. Preemptible is the cheaper option where allowed.
      preemptible: false,
      environmentVariables: [],
      ports: [{ containerPort: 8080, protocol: 'HTTP' }],
      volumes: [],
      // The 64 GiB floor; no shared memory (that is a vLLM requirement).
      disk: { type: 'NETWORK_SSD', sizeBytes: 68_719_476_736 },
      authToken: 'replace-with-a-real-token',
    })
    // ── Production-shaped GPU alternative (vLLM on an L40S) ─────────────────
    // The configuration `examples/ai.bindings.ts` uses. Swap it in for real
    // throughput; note the cost jump (GPU hour + 500 GiB + 16 GiB shm) and the
    // multi-minute CUDA/model warmup (`--enforce-eager` skips torch.compile and
    // CUDA-graph capture). Requires an eu-north1 project: the account's GPU quota
    // lives there and `gpu-l40s-a` does not exist in other regions. The program's
    // model name must match `--model` (vLLM rejects others) — set
    // `AI_CHAT_MODEL: 'Qwen/Qwen3-0.6B'` in the instance `env` below.
    //
    // const endpoint = yield* Nebius.ai.Endpoint('llm', {
    //   image: 'vllm/vllm-openai:v0.19.1',
    //   containerCommand: 'python3',
    //   args: '-m vllm.entrypoints.openai.api_server --model Qwen/Qwen3-0.6B --host 0.0.0.0 --port 8000 --enforce-eager',
    //   platform: 'gpu-l40s-a',
    //   preset: '1gpu-8vcpu-32gb',
    //   subnetId: subnet.id,
    //   publicIp: true,
    //   preemptible: true,
    //   environmentVariables: [],
    //   ports: [{ containerPort: 8000, protocol: 'HTTP' }],
    //   volumes: [],
    //   disk: { type: 'NETWORK_SSD', sizeBytes: 536_870_912_000 },
    //   shmSizeBytes: 17_179_869_184,
    //   authToken: 'replace-with-a-real-token',
    // })

    // ── The runtime: a hosted instance that serves the chat program ─────────
    const instance = yield* Nebius.compute.Instance(
      'AiChatInstance',
      {
        serviceAccountId: sa.id,
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        bootDisk: {
          attachMode: 'READ_WRITE',
          managedDisk: {
            name: 'boot-disk',
            // ≥ 64 GiB floor + an OS image: a blank disk never boots cloud-init.
            spec: {
              type: 'NETWORK_SSD',
              sizeGibibytes: 64,
              sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
            },
          },
        },
        networkInterfaces: [
          {
            subnetId: subnet.id,
            name: 'eth0',
            ipAddress: { allocationId: '' },
            publicIpAddress: { static: false },
            securityGroups: [{ id: sg.id }],
          },
        ],
        // The program bundled onto the VM (deep imports, minified: the bundle is
        // ~1 MB minified vs ~2.7 MB without — the VM downloads every chunk).
        main: PROGRAM_MAIN,
        port: 3000,
        build: { output: { minify: true } },
        // Shipped into the program's environment (read via Config there).
        env: {
          AI_CHAT_SUBNET_ID: subnet.id,
          AI_CHAT_SA_ID: sa.id,
          AI_CHAT_MODEL: SERVED_MODEL,
        },
      },
      Effect.gen(function* () {
        // DEPLOY-SIDE binding registration. This init Effect runs at plan/deploy
        // (a bundle is never executed by the CLI), which is the only place the
        // instance is its own binding host; it injects NEBIUS_ENDPOINT_URL +
        // NEBIUS_ENDPOINT_AUTH_TOKEN into the systemd EnvironmentFile. The VM's
        // program then calls the same typed contract against `process.env`.
        yield* Nebius.ai.ChatCompletions(endpoint).pipe(
          Effect.provide(Nebius.ai.ChatCompletionsHttp),
        )
        // No handler shape on purpose: the VM runs its own program.
      }),
    )

    return {
      instanceId: instance.id,
      endpointId: endpoint.id,
      region: REGION,
      hint: 'curl "http://<instance-public-ip>:3000/?prompt=..." (see the doc comment for the IP lookup)',
    }
  }),
)
