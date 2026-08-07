/**
 * M6 — real-infra e2e for the AI endpoint bindings (AI_BINDINGS.md M6).
 *
 * SLOW_TESTS-gated: deploys a real endpoint (nginx on cpu-d3 — the cheap,
 * deterministic wiring-validation combo; the GPU vLLM config in
 * `examples/ai.bindings-worker.ts` is the chat-capable variant) and exercises
 * the REAL binding layer against it:
 *
 *  1. Deploy-time wiring — endpointToEnv → registerEnvOnce → host.bind with a
 *     mocked Worker host. Asserts the injected env carries the endpoint's
 *     MANAGED https URL (regression for the raw `IP:port` bug) and the token
 *     as a `secret_text` binding.
 *  2. Runtime — chatCompletions via the real layer against the REAL endpoint:
 *     nginx answers 404 on /v1/chat/completions → EndpointNotFound. That
 *     proves reachability + the tagged error mapping against real infra. A
 *     real chat round-trip (200 + completion) requires the GPU vLLM config —
 *     verified manually, documented in the example.
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
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as VpcGrpc from '../../../../modules/api-client/vpc.ts'
import * as AiGrpc from '../../../../modules/api-client/ai.ts'
import * as Bindings from '../../../../modules/resources/ai/v1/bindings.ts'
import * as BindingsSchema from '../../../../modules/resources/ai/v1/bindings.schema.ts'
import type { EndpointProps } from '../../../../modules/resources/ai/v1/endpoint.schema.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!

/** The cheap wiring-validation combo: nginx on cpu-d3, one HTTP port, token auth. */
const ENDPOINT_PROPS: Omit<EndpointProps, 'subnetId'> = {
  image: 'nginx:alpine',
  platform: 'cpu-d3',
  preset: '4vcpu-16gb',
  publicIp: true,
  preemptible: false,
  environmentVariables: [],
  ports: [{ containerPort: 80, protocol: 'HTTP' }],
  volumes: [],
  disk: { type: 'NETWORK_SSD', sizeBytes: 10_737_418_240 },
  authToken: 'm6-integration-token',
}

/**
 * Post-destroy leak verification: anything named `m6test-*` surviving the
 * destroy is a leak (a failed destroy used to leave network/subnet/endpoint
 * remnants silently).
 */
const verifyNoLeaks = Effect.gen(function* () {
  const vpc = yield* VpcGrpc.VpcGrpcService
  const ai = yield* AiGrpc.AiGrpcService
  const leaked: string[] = []
  for (const n of yield* vpc.network.list(PROJECT)) {
    if (n.metadata?.name?.startsWith('m6test-')) leaked.push(`network ${n.metadata.name}`)
  }
  for (const s of yield* vpc.subnet.list(PROJECT)) {
    if (s.metadata?.name?.startsWith('m6test-')) leaked.push(`subnet ${s.metadata.name}`)
  }
  for (const e of yield* ai.endpoint.list(PROJECT)) {
    if (e.metadata?.name?.startsWith('m6test-')) leaked.push(`endpoint ${e.metadata.name}`)
  }
  if (leaked.length > 0) {
    return yield* Effect.fail(new Error(`LEAKED after destroy: ${leaked.join(', ')}`))
  }
})

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

          // Runtime against the REAL endpoint: nginx 404s /v1/chat/completions
          // → the binding maps it to EndpointNotFound. Collapse to a marker
          // string so the assertion below is unambiguous.
          return yield* chat(
            new BindingsSchema.ChatCompletionRequest({
              model: 'm6-test-model',
              messages: [{ role: 'user', content: 'hello from M6' }],
            }),
          ).pipe(
            Effect.match({
              onFailure: (e) => (e._tag === 'EndpointNotFound' ? 'EndpointNotFound' : `unexpected error: ${String(e)}`),
              onSuccess: () => 'unexpected success',
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

      // Runtime: nginx 404 → EndpointNotFound.
      expect(outcome).toBe('EndpointNotFound')
      console.log('[M6] runtime hit the real endpoint → EndpointNotFound (nginx 404) OK')
    }).pipe(
      // nginx provisions fast, but keep headroom for slow VM scheduling.
      safeDestroy(stack, verifyNoLeaks),
    ),
  { timeout: 900_000 },
)
