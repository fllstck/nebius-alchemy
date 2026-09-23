import * as BunTest from 'bun:test'

import * as Package from '../modules/index.ts'

const { describe, expect, test } = BunTest

/**
 * Every branded id must be **reachable from the package namespace**.
 *
 * AGENTS.md §"Branded IDs" states this as an invariant — "the package re-exports the brands as
 * **values**, so `Nebius.iam.ServiceAccountId.make(…)` works for consumers" — and it is load-bearing,
 * because a brand is what makes a prop type-check. Reading an id off a resource output needs nothing
 * (`zone.id` is already branded), but an id from *outside* an output — an env var, a config file, a
 * `spawnSync`ed CLI — must be branded at that boundary, and the only way to do that is `.make(…)` on
 * the exported schema.
 *
 * It was false for **23 of the brands** until 2026-09-23: `iam/v1` exported two of its thirteen, and the
 * `kms`, `storage`, `ai`, `dns`, `mysterybox` and `iam/v2` versions exported none. The consequence was
 * not cosmetic — `Nebius.iam.GroupMembership`'s `memberId`, `Nebius.iam.AccessPermit`'s `resourceId`
 * and every `kmsKeyId` prop were **unconstructable from outside the package**, since a branded prop
 * rejects a plain string. Found by writing `examples/mk8s.ts`, which needs `AccessPermitResourceId` for
 * the node group's service-account grant.
 *
 * The check is mechanical and one-directional on purpose: it asks only that each declared brand is
 * reachable, so adding a brand to a service `ids.ts` without exporting it fails here, while internal
 * helpers (a union of brands, an issue function) stay free to be unexported.
 */
describe('package namespace exports every branded id', () => {
  /** Service **path** (`<service>/<version>`) → the namespace object a consumer reaches it through. */
  const namespaces: Record<string, Record<string, unknown>> = {
    'ai/v1': Package.ai,
    'billing/v1': Package.billing,
    'capacity/v1': Package.capacity,
    'compute/v1': Package.compute,
    'dns/v1': Package.dns,
    // `iam` merges v1 and v2 under one namespace (AGENTS.md §"Namespace hierarchy").
    'iam/v1': Package.iam,
    'iam/v2': Package.iam,
    'kms/v1': Package.kms,
    'mk8s/v1': Package.mk8s,
    'mysterybox/v1': Package.mysterybox,
    'storage/v1': Package.storage,
    'vpc/v1': Package.vpc,
  }

  for (const [service, namespace] of Object.entries(namespaces)) {
    test(`${service}: every brand in ids.ts is exported as a value`, async () => {
      const ids = (await import(`../modules/resources/${service}/ids.ts`)) as Record<string, unknown>
      const brands = Object.keys(ids).filter((name) => name.endsWith('Id'))
      expect(brands.length, `${service}/ids.ts declares no brands — did the file move?`).toBeGreaterThan(0)

      const missing = brands.filter((brand) => namespace[brand] === undefined)
      expect(
        missing,
        `${service}: these brands are declared in ids.ts but unreachable as \`Nebius.<service>.<Brand>\`. ` +
          `Add them to modules/resources/${service}/index.ts (\`export { … } from './ids.ts'\`) — without ` +
          `the value, a consumer cannot brand an id it did not get from a resource output, and the prop ` +
          `that takes it is unconstructable (AGENTS.md §"Branded IDs")`,
      ).toEqual([])

      // …and the namespace must hand back the *same* schema object, not a namesake.
      for (const brand of brands) expect(namespace[brand]).toBe(ids[brand])
    })
  }
})
