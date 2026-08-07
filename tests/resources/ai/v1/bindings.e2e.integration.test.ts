/**
 * M6 — real-infra e2e for the AI endpoint bindings (AI_BINDINGS.md M6).
 *
 * ⚠️ OPT-IN ONLY: requires BOTH `SLOW_TESTS=1` AND `M6_E2E=1`, and a
 * dedicated slot — it deploys a GPU endpoint (vLLM Qwen3-0.6B) and the
 * platform's teardown is slow (~30+ min total, GPU cost). The PRIMARY gate is
 * the manual end-to-end verification (examples/ai.bindings.ts + curl to the
 * worker) plus the unit suite. This test exists to lock in the wiring
 * assertions (managed https URL, secret_text token) and a real chat
 * round-trip when someone deliberately runs it.
 *
 * Deploy-time wiring: endpointToEnv → registerEnvOnce → host.bind with a
 * mocked Worker host — asserts the injected env carries the endpoint's
 * MANAGED https URL (regression for the raw `IP:port` bug) and the token as a
 * `secret_text` binding. Runtime: a REAL chat round-trip through the layer.
 *
 * PATTERN (agent-patterns/alchemy-test-patterns.md): staged deploys; every
 * stage re-declares the full resource set (noops) so the re-plan doesn't
 * DELETE anything mid-test.
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { WorkerEnvironment } from 'alchemy/Cloudflare/Workers'
import { Self } from 'alchemy/Self'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect, test as bunTest } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as VpcGrpc from '../../../../modules/api-client/vpc.ts'
import * as AiGrpc from '../../../../modules/api-client/ai.ts'
import * as Bindings from '../../../../modules/resources/ai/v1/bindings.ts'
import * as BindingsSchema from '../../../../modules/resources/ai/v1/bindings.schema.ts'
import type { EndpointProps } from '../../../../modules/resources/ai/v1/endpoint.schema.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!

/** The proven config: vLLM Qwen3-0.6B on an L40S GPU (cookbook template, --enforce-eager). */
const ENDPOINT_PROPS: Omit<EndpointProps, 'subnetId'> = {
  image: 'vllm/vllm-openai:v0.19.1',
  containerCommand: 'python3',
  args: '-m vllm.entrypoints.openai.api_server --model Qwen/Qwen3-0.6B --host 0.0.0.0 --port 8000 --enforce-eager',
  platform: 'gpu-l40s-a',
  preset: '1gpu-8vcpu-32gb',
  publicIp: true,
  preemptible: true,
  environmentVariables: [],
  ports: [{ containerPort: 8000, protocol: 'HTTP' }],
  volumes: [],
  disk: { type: 'NETWORK_SSD', sizeBytes: 107_374_182_400 }, // 100 GiB (template uses 500)
  shmSizeBytes: 17_179_869_184, // 16 GiB
  authToken: 'm6-integration-token',
}

/**
 * Post-destroy leak verification: anything named
 * `nebius-ai-bindings-chatcompletionshttp-*` (the slugged test name) surviving
 * the destroy is a leak (a failed destroy used to leave
 * network/subnet/endpoint remnants silently).
 */
const LEAK_PREFIX = 'nebius-ai-bindings-chatcompletionshttp'

const verifyNoLeaks = Effect.gen(function* () {
  const vpc = yield* VpcGrpc.VpcGrpcService
  const ai = yield* AiGrpc.AiGrpcService
  const leaked: string[] = []
  for (const n of yield* vpc.network.list(PROJECT)) {
    if (n.metadata?.name?.startsWith(LEAK_PREFIX)) leaked.push(`network ${n.metadata.name}`)
  }
  for (const s of yield* vpc.subnet.list(PROJECT)) {
    if (s.metadata?.name?.startsWith(LEAK_PREFIX)) leaked.push(`subnet ${s.metadata.name}`)
  }
  for (const e of yield* ai.endpoint.list(PROJECT)) {
    if (e.metadata?.name?.startsWith(LEAK_PREFIX)) leaked.push(`endpoint ${e.metadata.name}`)
  }
  if (leaked.length > 0) {
    return yield* Effect.fail(new Error(`LEAKED after destroy: ${leaked.join(', ')}`))
  }
})

// ⚠️ Double-gated: SLOW_TESTS alone must NOT run this — it needs an explicit
// M6_E2E=1 opt-in AND a dedicated slot (GPU endpoint, ~30+ min, slow teardown).
if (process.env.M6_E2E !== '1') {
  bunTest.skip('Nebius.ai bindings — real-infra e2e (M6) — opt-in: SLOW_TESTS=1 M6_E2E=1', () => {})
} else {
  integrationTest(
    test.provider,
    'Nebius.ai bindings — ChatCompletionsHttp wiring + runtime against a real endpoint (M6)',
  (stack) =>
    Effect.gen(function* () {
      // Stage 1 — network + subnet + endpoint alone. The endpoint provider's
      // readiness wait guarantees RUNNING (publicEndpoints populated).
      const { endpoint } = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Nebius.vpc.Network('M6Test-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('M6Test-Subnet', { networkId: network.id })
          const endpoint = yield* Nebius.ai.Endpoint('M6Test-Endpoint', { ...ENDPOINT_PROPS, subnetId: subnet.id })
          return { network, subnet, endpoint }
        }),
      )
      expect(endpoint.id).toMatch(/^aiendpoint-/)
      // The handle's attributes resolve post-deploy; the readiness wait means
      // RUNNING with public endpoints.
      expect(endpoint.publicEndpoints.length).toBeGreaterThan(0)
      const managedUrl = endpoint.publicEndpoints.find((e) => e.startsWith('https://'))
      expect(managedUrl).toBeDefined()
      console.log(`[M6] endpoint RUNNING, managed URL: ${managedUrl}`)

      // Stage 2 — re-declare everything (noops) and run the REAL binding layer
      // with a mocked Worker host. The deploy-time branch executes (guard unset
      // in the test process): endpointToEnv resolves the real attrs →
      // registerEnvOnce → host.bind records the env on the mock.
      const hostCalls: Array<{ sid: string; data: unknown }> = []
      const mockHost = {
        Type: 'Cloudflare.Worker',
        LogicalId: 'M6MockHost',
        bind: (sid: string, data: unknown) => {
          hostCalls.push({ sid, data })
          return Effect.void
        },
      } as never

      const outcome = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Nebius.vpc.Network('M6Test-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('M6Test-Subnet', { networkId: (yield* Nebius.vpc.Network('M6Test-Network', {})).id })
          const endpoint = yield* Nebius.ai.Endpoint('M6Test-Endpoint', { ...ENDPOINT_PROPS, subnetId: subnet.id })

          const chat = yield* Bindings.ChatCompletions(endpoint).pipe(
            Effect.provide(Bindings.ChatCompletionsHttp),
            Effect.provide(Layer.succeed(Self('Cloudflare.Worker'), mockHost)),
            Effect.provide(
              Layer.succeed(WorkerEnvironment, {
                NEBIUS_ENDPOINT_URL: managedUrl,
                NEBIUS_ENDPOINT_AUTH_TOKEN: 'm6-integration-token',
              }),
            ),
          )

          // Runtime against the REAL endpoint: a real chat completion through
          // the layer (200 + decoded ChatCompletion). Collapse to a string:
          // the content on success, an error description on failure.
          return yield* chat(
            new BindingsSchema.ChatCompletionRequest({
              model: 'Qwen/Qwen3-0.6B',
              messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
              max_tokens: 32,
            }),
          ).pipe(
            Effect.match({
              onFailure: (e) => `chat call failed: ${String(e)}`,
              onSuccess: (r) => (r.stream === false ? r.response.choices[0]?.message.content ?? '' : 'unexpected stream result'),
            }),
          )
        }),
      )

      // The deploy-time wiring recorded the managed URL + secret token.
      const sids = hostCalls.map((c) => c.sid)
      expect(sids).toContain('Nebius.ai.v1.Endpoint.ChatCompletions')
      const bindings = hostCalls.flatMap((c) => (c.data as { bindings?: unknown[] }).bindings ?? [])
      const urlBinding = bindings.find((b) => (b as { name?: string }).name === 'NEBIUS_ENDPOINT_URL') as
        | { type: string; text: string }
        | undefined
      expect(urlBinding?.type).toBe('plain_text')
      // REGRESSION (the raw IP:port bug): the URL must be the managed https URL.
      expect(urlBinding?.text.startsWith('https://')).toBe(true)
      expect(urlBinding?.text).toBe(managedUrl)
      const tokenBinding = bindings.find((b) => (b as { name?: string }).name === 'NEBIUS_ENDPOINT_AUTH_TOKEN') as
        | { type: string; text: string }
        | undefined
      expect(tokenBinding?.type).toBe('secret_text')
      expect(tokenBinding?.text).toBe('m6-integration-token')

      // Runtime: a real chat completion through the binding.
      expect(outcome).not.toMatch(/^chat call failed/)
      expect(outcome.length).toBeGreaterThan(0)
      console.log(`[M6] real chat round-trip through the binding OK: ${outcome.slice(0, 80)}`)
    }).pipe(
      // Budget = deploy (op poll + readiness, up to ~25 min) + teardown (slow
      // on this platform — subnet deletes wait on the endpoint VM).
      safeDestroy(stack, verifyNoLeaks),
    ),
    { timeout: 1_800_000 },
  )
}
