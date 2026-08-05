import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

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
      expect(endpoint.privateEndpoints).toBeDefined()
    }).pipe(safeDestroy(stack)),
  { timeout: 300_000 },
)
