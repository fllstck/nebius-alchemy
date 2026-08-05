import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

integrationTest(test.provider, 'Nebius.vpc.v1.Pool lifecycle', (stack) =>
  Effect.gen(function* () {
    const pool = yield* stack.deploy(
      Nebius.vpc.Pool('LifecycleTest', {
        version: 'IPV4',
        visibility: 'PRIVATE',
        cidrs: [{ cidr: '10.0.0.0/24' }],
      }),
    )

    expect(pool.id).toBeDefined()
    expect(typeof pool.id).toBe('string')
    expect(pool.name).toBeDefined()
    expect(pool.version).toBe('IPV4')
    expect(pool.visibility).toBe('PRIVATE')
    expect(pool.state).toBe('READY')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
