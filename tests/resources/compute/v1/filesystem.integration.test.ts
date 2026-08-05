import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(true)(
  'Nebius.compute.v1.Filesystem lifecycle (requires paid tier — quota unavailable for trial accounts)',
  (stack) =>
  Effect.gen(function* () {
    const fs = yield* stack.deploy(
      Nebius.compute.Filesystem('LifecycleTest', {
        type: 'NETWORK_SSD',
        sizeGibibytes: 4,
      }),
    )

    expect(fs.id).toBeDefined()
    expect(typeof fs.id).toBe('string')
    expect(fs.name).toBeDefined()
    expect(fs.type).toBe('NETWORK_SSD')
    expect(fs.state).toBe('READY')
  }).pipe(
    Effect.ensuring(stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )),
  ),
  { timeout: 180_000 },
)
