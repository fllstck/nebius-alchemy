import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { redact, safeDestroy } from '../../../helpers/cleanup.ts'
import * as MysteryBoxGrpc from '../../../../modules/api-client/mysterybox.ts'
import * as NebiusSecretVersionSchema from '../../../../schemas/nebius/mysterybox/v1/secret_version.ts'

integrationTest(test.provider, 'Nebius.mysterybox.v1.SecretVersion lifecycle', (stack) =>
  Effect.gen(function* () {
    // Parent secret + version in ONE deploy: `stack.deploy(expr)` declares the
    // full desired state per call — a second deploy omitting the Secret would
    // plan its deletion, cascade-deleting the version (leaked NOT_FOUND on
    // destroy). See route.integration.test.ts for the same pattern.
    const { secret, version } = yield* stack.deploy(
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

    // ── Spec-only change ⇒ REPLACE (production path) ─────────────────────────
    // The service has no Update RPC, so a `description` change cannot be written
    // in place: the version is replaced, delete-first (the physical name is
    // `sv-<logicalId>` on every generation). Re-declaring the Secret is required:
    // each `stack.deploy` states the full desired set (see the note above).
    const replaced = yield* Effect.exit(
      stack.deploy(
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
      ),
    )

    if (Exit.isSuccess(replaced)) {
      // A new id proves the plan was a replace, not an update that wrote nothing —
      // and success proves the soft-deleted name was free at create time, so
      // delete-first ordering is right and `forget: ['delete']` needs no change.
      expect(replaced.value.version.id).not.toBe(version.id)
      expect(replaced.value.version.description).toBe('Replaced version')
      expect(replaced.value.version.state).toBe('ACTIVE')
      return
    }

    // ── Control arm: the probe FAILED, so why? ───────────────────────────────
    // The failure alone only proves that a create was refused while a sibling was
    // SCHEDULED_FOR_DELETION. Creating a version with a DIFFERENT name under the
    // same secret (still holding the pending-deletion sibling) separates the two
    // causes, and is what makes one run answer TASKS.md §N1 instead of needing a
    // second:
    //   control SUCCEEDS → the blocker is `metadata.name` being retained by the
    //                      soft-deleted version;
    //   control FAILS    → ANY create is refused while a sibling is pending
    //                      deletion, so the delete must COMPLETE (not just be
    //                      issued) before the replacement is created.
    const control = yield* Effect.exit(
      Effect.gen(function* () {
        const svc = yield* MysteryBoxGrpc.MysteryBoxGrpcService
        return yield* svc.secretVersion.create({
          metadata: { parentId: secret.id, name: 'sv-probe-control' },
          spec: NebiusSecretVersionSchema.SecretVersionSpec.fromJSON({
            description: 'control arm — different name, same pending-deletion secret',
            payload: [{ key: 'control-key', stringValue: 'control-value' }],
          }),
        })
      }),
    )

    return yield* Effect.fail(
      new Error(
        [
          'SecretVersion same-name replace failed — probe result (TASKS.md §N1):',
          `  • replacement (delete-first, name \`sv-lifecycletest\`) FAILED: ${redact(String(replaced.cause))}`,
          Exit.isSuccess(control)
            ? '  • control (DIFFERENT name, same pending-deletion secret) SUCCEEDED → `metadata.name` is retained by the soft-deleted version. Next: await the delete LRO (`forget: [\'delete\']` → polling in api-client/mysterybox.ts); if that still fails, the name is held until `purgeAt` and delete-first cannot work — the physical name needs a generation discriminator, or `payload`/`description` must be declared create-only with a plan-time error.'
            : `  • control (DIFFERENT name) ALSO FAILED → any create is refused while a sibling is SCHEDULED_FOR_DELETION; the delete must complete before creating. Next: await the delete LRO (same one-line change). Control failure: ${redact(String(control.cause))}`,
        ].join('\n'),
      ),
    )
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 180_000 },
)
