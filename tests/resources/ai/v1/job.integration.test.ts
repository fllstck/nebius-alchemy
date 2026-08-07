import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as VpcGrpc from '../../../../modules/api-client/vpc.ts'
import * as AiGrpc from '../../../../modules/api-client/ai.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID!

/** Post-destroy leak verification — see endpoint.integration.test.ts. */
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
  const jobs = yield* ai.job.list(PROJECT)
  for (const j of jobs) {
    if (j.metadata?.name?.startsWith('nebius-ai-v1-')) leaked.push(`job ${j.metadata.name}`)
  }

  if (leaked.length > 0) {
    return yield* Effect.fail(new Error(`LEAKED after destroy: ${leaked.join(', ')}`))
  }
})

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
      // Jobs are short-lived — accept any terminal/in-flight state.
      expect(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']).toContain(job.state)
    }).pipe(
      // Long timeout: the job's VM must settle before the destroy runs
      // (a mid-create destroy is the historical leak path).
      safeDestroy(stack, verifyNoLeaks),
    ),
  { timeout: 1_800_000 },
)
