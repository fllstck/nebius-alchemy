import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const { test } = Test.make({ providers: Nebius.providers() as any })

integrationTest(test.provider, 'Nebius.iam.v2.Project lifecycle', (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Nebius.iam.Project('LifecycleTest', {
        region: 'eu-north1',
      }),
    )

    expect(created.id).toBeDefined()
    expect(typeof created.id).toBe('string')
    expect(created.name).toBeDefined()
    if (created.region) {
      expect(created.region).toBe('eu-north1')
    }
    expect(created.state).toBeDefined()

    // --- Update (region change) ---
    const updated = yield* stack.deploy(
      Nebius.iam.Project('LifecycleTest', {
        region: 'eu-west1',
      }),
    )

    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe(created.name)
  }).pipe(
    Effect.ensuring(safeDestroy(stack)),
  ),
  { timeout: 120_000 },
)
