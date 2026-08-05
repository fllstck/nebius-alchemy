import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.vpc.v1.Pool lifecycle', (stack) =>
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
    Effect.ensuring(stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )),
  ),
  { timeout: 120_000 },
)
