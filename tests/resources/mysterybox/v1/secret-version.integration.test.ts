import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'

integrationTest(test.provider, 'Nebius.mysterybox.v1.SecretVersion lifecycle', (stack) =>
  Effect.gen(function* () {
    // Create parent secret first
    const secret = yield* stack.deploy(
      Nebius.mysterybox.Secret('SVTestSecret', {
        description: 'Secret for version test',
        payloads: [{ key: 'init-key', stringValue: 'init-value' }],
      }),
    )

    const version = yield* stack.deploy(
      Nebius.mysterybox.SecretVersion('LifecycleTest', {
        parentId: secret.id as never,
        description: 'Alchemy integration test version',
        payload: [{ key: 'test-key', stringValue: 'test-value' }],
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
