import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as VpcGrpc from '../../../../modules/api-client/vpc.ts'
import * as AiGrpc from '../../../../modules/api-client/ai.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!

/**
 * Post-destroy leak verification: the endpoint test creates a network +
 * subnet + endpoint. A failed destroy (e.g. the endpoint delete failing and
 * cascading into the subnet/network deletes) used to leak all three silently.
 * This fails the test loudly if anything named `nebius-ai-v1-*` survives.
 */
const verifyNoLeaks = Effect.gen(function* () {
  const vpc = yield* VpcGrpc.VpcGrpcService
  const ai = yield* AiGrpc.AiGrpcService
  const leaked: string[] = []

  const networks = yield* vpc.network.list(PROJECT)
  for (const n of networks) {
    if (n.metadata?.name?.startsWith('nebius-ai-v1-')) leaked.push(`network ${n.metadata.name}`)
  }
  const subnets = yield* vpc.subnet.list(PROJECT)
  for (const s of subnets) {
    if (s.metadata?.name?.startsWith('nebius-ai-v1-')) leaked.push(`subnet ${s.metadata.name}`)
  }
  const endpoints = yield* ai.endpoint.list(PROJECT)
  for (const e of endpoints) {
    if (e.metadata?.name?.startsWith('nebius-ai-v1-')) leaked.push(`endpoint ${e.metadata.name}`)
  }

  if (leaked.length > 0) {
    return yield* Effect.fail(new Error(`LEAKED after destroy: ${leaked.join(', ')}`))
  }
})

integrationTest(
  test.provider,
  'Nebius.ai.v1.Endpoint lifecycle',
  (stack) =>
    Effect.gen(function* () {
      const { endpoint } = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Nebius.vpc.Network('EndpointTest-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('EndpointTest-Subnet', {
            networkId: network.id,
          })
          const endpoint = yield* Nebius.ai.Endpoint('EndpointTest-Endpoint', {
            image: 'nginx:alpine',
            platform: 'cpu-d3',
            preset: '4vcpu-16gb',
            subnetId: subnet.id,
            publicIp: true,
            preemptible: false,
            environmentVariables: [],
            ports: [{ containerPort: 80, protocol: 'HTTP' }],
            volumes: [],
            disk: { type: 'NETWORK_SSD', sizeBytes: 107_374_182_400 }, // 100 GiB (≥ 64 GiB floor)
            // One HTTP port only → auth is valid. The API never echoes this
            // back; M1 (AD1) synthesizes it from props so bindings can read
            // it off the handle — assert it survives into the output attrs.
            authToken: 'integration-test-token',
          })
          return { network, subnet, endpoint }
        }),
      )

      expect(endpoint.id).toBeDefined()
      expect(typeof endpoint.id).toBe('string')
      expect(endpoint.name).toBeDefined()
      // VM provisioning can take a while — accept any in-flight state here;
      // the stack deploy already polls the create operation to completion.
      expect(['PROVISIONING', 'STARTING', 'RUNNING']).toContain(endpoint.state)
      expect(endpoint.publicEndpoints).toBeDefined()
      // AD1: the one-time authToken survives into the deployed output.
      expect(endpoint.authToken).toBe('integration-test-token')
    }).pipe(
      // Long timeout: endpoint VM provisioning routinely exceeds 120s — the
      // destroy must run against a settled endpoint, not a mid-create one
      // (a mid-create destroy is the historical leak path).
      safeDestroy(stack, verifyNoLeaks),
    ),
  { timeout: 1_800_000 },
)
