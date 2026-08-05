import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(
  test.provider,
  'Nebius.ai.v1.Job lifecycle',
  (stack) =>
    Effect.gen(function* () {
      const { job } = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Nebius.vpc.Network('JobTest-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('JobTest-Subnet', {
            networkId: network.id,
          })
          const job = yield* Nebius.ai.Job('JobTest-Job', {
            image: 'ubuntu',
            containerCommand: 'sleep',
            args: '5',
            platform: 'cpu-d3',
            preset: '4vcpu-16gb',
            subnetId: subnet.id,
            publicIp: false,
            preemptible: false,
            environmentVariables: [{ name: 'TEST', value: '1' }],
            ports: [],
            volumes: [],
            disk: { type: 'NETWORK_SSD', sizeBytes: 10_737_418_240 },
          })
          return { network, subnet, job }
        }),
      )

      expect(job.id).toBeDefined()
      expect(typeof job.id).toBe('string')
      expect(job.name).toBeDefined()
      // Run-to-completion: accept any non-empty state — the job may already
      // have finished (COMPLETED/FAILED) by the time the operation polls out.
      expect(job.state).toBeDefined()
      expect(job.state.length).toBeGreaterThan(0)
    }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)
