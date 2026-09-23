import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// PricingPolicy — the billing resource a `pricing.spotPricingPolicy.id` names
// ---------------------------------------------------------------------------
//
// A project-scoped auction bid: for one compute platform it sets the maximum a preemptible VM may pay
// per GPU hour, and the platform uses it to rank VMs for scheduling and preemption. It provisions
// nothing, which is why it is the one resource in this family that can be verified live cheaply.
//
// The proto's spec is `computeInstanceSpec.v1.platform` + `pricing.maxPriceV1.maxPrice`; both are
// reshaped here (see the props) and `update` does not exist on the wire in any usable form, so every
// change is a **replace** (see `pricing-policy.ts`, and the probe cited in `api-client/billing.ts`).

/** A decimal price string of up to three fractional digits, e.g. `"3.515"`. */
const priceValid = Schema.makeFilter((value: string) =>
  /^\d+(\.\d{1,3})?$/.test(value)
    ? undefined
    : `${value} is not a price: the API wants a decimal string with at most three fractional digits (e.g. "3.515")`,
)

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export const PricingPolicyPropsSchema = Schema.Struct({
  /** The project that owns the policy. Only VMs inside it may reference it. */
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  /**
   * Labels — **accepted by the service and then discarded.** Measured live 2026-09-24
   * (`spikes/billing-labels-probe.ts`): a create carrying three labels reads back with `{}`, still `{}`
   * five seconds later. The prop is kept because it is the fleet-wide shape (and because the provider
   * still sends its internal ownership tags, so the day the service starts storing them this resource
   * needs no change), but nothing reads them back and there is **no way to tell a policy you made from
   * one you did not**: `Factory.makeCrudRead`'s `hasAlchemyTags` check can never be true, so every read of
   * a live policy is reported `Unowned` — asserted live in
   * `tests/resources/billing/v1/pricing-policy.integration.test.ts`, so a service fix cannot land
   * silently either.
   */
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * The compute platform whose preemptible VMs this policy prices, e.g. `gpu-h100-sxm` (the advisor's
   * live platform set is the authority — `Nebius.capacity.action.ListResourceAdvice`).
   *
   * **A deliberate reshape** of `spec.computeInstanceSpec.v1.platform`: the nesting holds a single
   * `platform` field under a version marker (`v1`) that a caller never chooses, so the prop is flat and
   * the provider re-nests it. Documented here as AGENTS.md §"Naming" requires.
   */
  platform: Schema.String.check(Validation.isNonEmptyString('platform')),
  /**
   * The maximum price per GPU hour, as a decimal string in USD with up to three fractional digits
   * (e.g. `"3.515"`) — **a string, not a number**, because that is what the API takes and what it
   * echoes, and because the value is money rather than a quantity suitable for arithmetic.
   *
   * ⚠️ The API **normalizes** it: `"3.000"` is stored and echoed as `"3"` (measured live 2026-09-24), so
   * attributes report the normalized form. That normalization never drives a plan: `diff` compares props
   * to **stored props**, not to the live echo — and any real price change is a *replacement* anyway,
   * because the service has no usable `update` (see `api-client/billing.ts`).
   *
   * A value inside the platform's allowed range is required (`OUT_OF_RANGE` otherwise) and the range is
   * not published — the API's error is the only place it appears. A price below the current market price
   * is accepted and simply blocks scheduling until the market falls to it, which the status reports as
   * `SCHEDULING_STATE_BLOCKED`.
   */
  maxPrice: Schema.String.check(priceValid),
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A policy that still prices running VMs cannot be deleted — the API refuses with `FAILED_PRECONDITION`.
 * The status carries the count, so the provider pre-checks it and names the consequence, the same shape
 * as `GpuClusterNotEmpty`/`NVLInstanceGroupNotEmpty`.
 */
export class PricingPolicyHasRunningVms extends Schema.TaggedError<PricingPolicyHasRunningVms>()(
  'PricingPolicyHasRunningVms',
  {
    id: Schema.String,
    runningVmCount: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Pricing policy ${this.id} still prices ${this.runningVmCount} running VM(s), and the API refuses to delete a policy in use.\n` +
      '  - stop or delete those preemptible VMs first (they reference this policy through `pricing.spotPricingPolicy.id`)\n' +
      '  - or leave the policy in place: it costs nothing while no VM references it'
    )
  }
}

export type PricingPolicyProps = typeof PricingPolicyPropsSchema.Type

export const validatePricingPolicyProps = Validation.makeValidateProps(PricingPolicyPropsSchema)

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

export const PricingPolicyAttributesSchema = Schema.Struct({
  id: Ids.PricingPolicyId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  platform: Schema.String,
  maxPrice: Schema.String,
  /** `CREATING` / `ACTIVE` / `DELETING` / `UPDATING` (the last while a bid change lands). */
  state: Schema.optional(Schema.String),
  /** Whether new VMs may currently start under this policy. */
  schedulingState: Schema.optional(Schema.String),
  /** The SKU the platform resolved from `platform`. */
  skuId: Schema.optional(Schema.String),
  /** ISO 4217 code as the API spells it — measured live 2026-09-24 as lowercase `"usd"`. */
  currency: Schema.optional(Schema.String),
  /** VMs currently running under this policy. Nonzero blocks both changes and deletion. */
  runningVmCount: Schema.optional(Schema.String),
})

export type PricingPolicyAttributes = typeof PricingPolicyAttributesSchema.Type
