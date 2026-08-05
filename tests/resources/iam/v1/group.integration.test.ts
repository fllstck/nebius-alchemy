import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'

const { test } = Test.make({ providers: Nebius.providers() as any })

integrationTest(test.provider, 'Nebius.iam.v1.Group lifecycle', (stack) =>
  Effect.gen(function* () {
    const group = yield* stack.deploy(
      Nebius.iam.Group('LifecycleTest', {}),
    )

    expect(group.id).toBeDefined()
    expect(typeof group.id).toBe('string')
    expect(group.name).toBeDefined()
    expect(group.state).toBeDefined()
  }).pipe(
    Effect.ensuring(stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )),
  ),
  { timeout: 120_000 },
)
