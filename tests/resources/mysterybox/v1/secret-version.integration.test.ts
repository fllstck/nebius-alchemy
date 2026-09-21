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

    // ── Spec-only change ⇒ REPLACE ───────────────────────────────────────────
    // The service has no Update RPC, so a `description` change cannot be written
    // in place: the version is replaced (delete-first — the physical name is
    // `sv-<logicalId>` on every generation). Re-declaring the Secret is required:
    // each `stack.deploy` states the full desired set (see the note above).
    //
    // This case is ALSO the live probe for the one thing the unit tests cannot
    // answer: a soft delete (status SCHEDULED_FOR_DELETION + `purgeAt`) may keep
    // the name reserved, in which case the replacement's create fails
    // ALREADY_EXISTS because it asks for the same `sv-lifecycletest`. If so, note
    // that the delete LRO is fire-and-forget here (`forget: ['delete']` in
    // api-client/mysterybox.ts) and `get` hides soft-deleted rows
    // (`showScheduledForDeletion: false`) — so first try awaiting the delete
    // before concluding the name is retained until purge.
    const { version: replaced } = yield* stack.deploy(
      Effect.gen(function* () {
        const secret = yield* Nebius.mysterybox.Secret('SVTestSecret', {
          description: 'Secret for version test',
          payloads: [{ key: 'init-key', stringValue: 'init-value' }],
        })
        const version = yield* Nebius.mysterybox.SecretVersion('LifecycleTest', {
          parentId: secret.id as never,
          description: 'Replaced version',
          payload: [{ key: 'test-key', stringValue: 'test-value' }],
        })
        return { secret, version }
      }),
    )

    // A new id proves the plan was a replace, not an update that wrote nothing.
    expect(replaced.id).not.toBe(version.id)
    expect(replaced.description).toBe('Replaced version')
    expect(replaced.state).toBe('ACTIVE')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 180_000 },
)
