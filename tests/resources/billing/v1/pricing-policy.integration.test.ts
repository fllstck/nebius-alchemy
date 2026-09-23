import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'

import { Nebius, test } from '../../../helpers/stack.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import * as BillingGrpc from '../../../../modules/api-client/billing.ts'

/**
 * The cheapest live verification in the package: a `PricingPolicy` provisions no VM, so this exercises
 * the whole provider path — create, a forced reconcile, the attribute mapper and destroy — for the price
 * of a few API calls.
 *
 * What it pins, all of it measured against the real service rather than a mock:
 *
 *  * `create` accepts the **nested** spec the provider builds from the flat props
 *    (`computeInstanceSpec.v1.platform` + `pricing.maxPriceV1.maxPrice`) and the policy reaches
 *    `STATE_ACTIVE`;
 *  * the **price is normalized by the API** — sending `"3.000"` comes back as `"3"` — so the assertion
 *    on the attribute is deliberately `"3"`, and the spec-echo check below reads the *live* rendering;
 *  * the policy's `metadata.resourceVersion` is **not a per-resource write counter**: a create-only
 *    deploy answers `7` (measured 2026-09-24), not `1`. That is why this test does not use the
 *    `live-echo` helper's `resourceVersion === 1` assertion — for this service the version is written by
 *    the platform during creation (the same class as `vpc/v1 Network`'s pool assignment) — and instead
 *    asserts the **spec echo is unchanged** after a forced reconcile, which is the part a drift loop
 *    would break;
 *  * a `labels`-only change is the declared non-converging prop (no update path sends labels), so it is
 *    the ideal forced-reconcile trigger: `diff` ignores it, `reconcile` runs, and nothing may be written.
 */
integrationTest(
  test.provider,
  'Nebius.billing.v1.PricingPolicy lifecycle (+ spec echo across a forced reconcile)',
  (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Nebius.billing.PricingPolicy('BillingPolicy', {
          platform: 'gpu-h100-sxm',
          maxPrice: '3.000',
        }),
      )

      expect(created.id).toBeDefined()
      expect(typeof created.id).toBe('string')
      expect(created.platform).toBe('gpu-h100-sxm')
      // The API normalizes: sent `3.000`, held as `3`.
      expect(created.maxPrice).toBe('3')
      expect(created.state).toBe('STATE_ACTIVE')
      expect(created.schedulingState).toBeDefined()
      expect(created.skuId).toBeDefined()
      // Lowercase on purpose — it is the API's own string.
      expect(created.currency).toBe('usd')
      expect(created.runningVmCount).toBe('0')

      const billing = yield* BillingGrpc.BillingGrpcService
      const live = yield* billing.pricingPolicy.get(created.id)
      // ⚠️ The service **accepts and discards** `metadata.labels` — measured live 2026-09-24, here and in
      // `spikes/billing-labels-probe.ts` (three labels sent, `{}` stored, still `{}` five seconds later).
      // So this resource cannot record ownership: `Factory.makeCrudRead`'s `hasAlchemyTags` check is always
      // false and every read of a live policy returns `Unowned`. Asserted rather than assumed, because a
      // silently-ignored field is exactly the class this repo tabs.
      expect(live.metadata?.labels ?? {}).toEqual({})
      const specEcho = JSON.stringify(live.spec)

      // The forced reconcile: a props change `diff` deliberately ignores, so `reconcile` runs against an
      // already-existing policy. Nothing may change — this is the drift-loop assertion for a resource
      // whose only convergence path is `diff`.
      const reconciled = yield* stack.deploy(
        Nebius.billing.PricingPolicy('BillingPolicy', {
          platform: 'gpu-h100-sxm',
          maxPrice: '3.000',
          labels: { 'forced-reconcile': 'true' },
        }),
      )
      expect(reconciled.id).toBe(created.id)
      expect(reconciled.maxPrice).toBe('3')
      const after = yield* billing.pricingPolicy.get(created.id)
      expect(JSON.stringify(after.spec)).toBe(specEcho)

      console.log(
        `PROBE billing pricing policy: id=${created.id} state=${created.state} platform=${created.platform} ` +
          `maxPrice=${created.maxPrice} currency=${created.currency} runningVmCount=${created.runningVmCount} ` +
          `resourceVersion(created)=${live.metadata?.resourceVersion?.toString()} (not a write counter)`,
      )
    }).pipe(safeDestroy(stack)),
  { timeout: 180_000 },
)
