import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'

integrationTest(test.provider, 'Nebius.mysterybox.v1.SecretVersion lifecycle', (stack) =>
  Effect.gen(function* () {
    // Parent secret + version in ONE deploy: `stack.deploy(expr)` declares the
    // full desired state per call — a second deploy omitting the Secret would
    // plan its deletion, cascade-deleting the version (leaked NOT_FOUND on
    // destroy). See route.integration.test.ts for the same pattern.
    const { version } = yield* stack.deploy(
      Effect.gen(function* () {
        const secret = yield* Nebius.mysterybox.Secret('SVTestSecret', {
          description: 'Secret for version test',
          payloads: [{ key: 'init-key', stringValue: 'init-value' }],
        })
        const version = yield* Nebius.mysterybox.SecretVersion('LifecycleTest', {
          parentId: secret.id as never,
          description: 'Alchemy integration test version',
          payload: [{ key: 'test-key', stringValue: 'test-value' }],
        })
        return { secret, version }
      }),
    )

    expect(version.id).toBeDefined()
    expect(typeof version.id).toBe('string')
    expect(version.description).toBe('Alchemy integration test version')
    expect(version.state).toBe('ACTIVE')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 180_000 },
)
