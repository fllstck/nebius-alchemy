import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(test.provider, 'Nebius.vpc.v1.Allocation lifecycle', (stack) =>
  Effect.gen(function* () {
    const { pool, allocation } = yield* stack.deploy(
      Effect.gen(function* () {
        const pool = yield* Nebius.vpc.Pool('AllocTest-Pool', {
          version: 'IPV4',
          visibility: 'PRIVATE',
          cidrs: [{ cidr: '10.0.0.0/24' }],
        })
        const allocation = yield* Nebius.vpc.Allocation('AllocTest-Allocation', {
          ipv4Private: { cidr: '10.0.0.1/32', poolId: pool.id },
        })
        return { pool, allocation }
      }),
    )

    expect(pool.id).toBeDefined()
    expect(allocation.id).toBeDefined()
    expect(typeof allocation.id).toBe('string')
    expect(allocation.name).toBeDefined()
    expect(['ALLOCATED', 'ASSIGNED']).toContain(allocation.state)
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
