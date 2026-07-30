import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

// ── Quotas Actions ─────────────────────────────────────────────────────────

/**
 * Quota allowances are auto-created by Nebius when a resource is provisioned.
 * These tests verify that discovery actions can list and find existing quota
 * entries without creating any new resources.
 */
test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.quotas.action.GetQuota / ListQuotas', (stack) =>
  Effect.gen(function* () {
    const { quotas, found } = yield* stack.deploy(
      Effect.gen(function* () {
        const quotas = yield* Nebius.quotas.action.ListQuotas({})
        // Look for a commonly-available quota metric
        const found = yield* Nebius.quotas.action.GetQuota({ name: 'compute.disk.count', region: 'eu-north1' })
        return { quotas, found }
      }),
    )

    // Quota allowances should exist in any active project
    expect(quotas.length).toBeGreaterThan(0)
    // The specific quota may or may not exist — just verify it doesn't throw
    if (found) {
      expect(found.name).toBe('compute.disk.count')
      expect(found.region).toBe('eu-north1')
    }
  }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
)
