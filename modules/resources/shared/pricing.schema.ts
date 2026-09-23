import * as Schema from 'effect/Schema'

import * as Validation from '../validation.ts'
import * as BillingIds from '../billing/v1/ids.ts'

// ---------------------------------------------------------------------------
// `pricing_model` — the oneof the 2026-09-24 schema pin bump added
// ---------------------------------------------------------------------------
//
// The same oneof appears on **four** spec messages: `compute/v1 InstanceSpec`, `mk8s/v1 NodeTemplate`,
// `ai/v1 JobSpec` and `ai/v1 EndpointSpec`. Two of them carry it **flat** (`on_demand`,
// `follows_spot_price`, `spot_pricing_policy{id}` as siblings — ts-proto renders a oneof with no
// accessor) and two as one message field (`pricingModel`). All four need the same arm shape and the same
// exactly-one rule, so those live here once; what stays per resource is the *doc* at the prop (the
// reshape, which arm couples to which `preemptible` prop, and what a change does to the resource).

/**
 * Exactly one pricing arm — the `PercentOrCount` pattern, not a `Schema.Union` of three structs.
 *
 * Measured 2026-09-23 (`agent-patterns/effect-schema.md`): a `Schema.Union` of structs **strips** the
 * keys that do not belong to the matched arm, so `{onDemand: true, followsSpotPrice: true}` would decode
 * to `{onDemand: true}` — a both-set mistake silently becoming one arm. One struct with all arms
 * optional plus this filter makes it a plan-time error instead.
 */
const exactlyOnePricingArm = Schema.makeFilter(
  (value: { onDemand?: boolean; followsSpotPrice?: boolean; spotPricingPolicy?: unknown }) => {
    const set = [value.onDemand, value.followsSpotPrice, value.spotPricingPolicy].filter(
      (arm) => arm !== undefined,
    ).length
    return set === 1
      ? undefined
      : `set exactly one of onDemand, followsSpotPrice, spotPricingPolicy — the proto models them as a single pricing_model oneof (got ${set})`
  },
)

/**
 * How a VM is priced. **Optional everywhere it is used, and omitting it is a valid request** — the
 * platform's default (`on_demand`, or the spot arm matching a preemptible VM).
 *
 * The two `true`s are presence switches for empty wire messages, checked with `Validation.trueOnly`
 * rather than `presenceOnly`: the latter's message ends "there is no way to disable it … short of
 * recreating", which misdescribes a oneof arm — the way to change the pricing mode is to set a
 * *different* arm, and `trueOnly` says exactly that (it exists for this case).
 */
export const PricingModelSchema = Schema.Struct({
  /** A regular, non-preemptible VM. The default when nothing is pinned. */
  onDemand: Schema.optional(
    Schema.Boolean.check(
      Validation.trueOnly(
        'pricing.onDemand',
        'the wire arm is an empty message (presence enables it) — to change the pricing mode set a different arm (followsSpotPrice/spotPricingPolicy)',
      ),
    ),
  ),
  /** A preemptible VM that accepts the current spot price. Requires the resource's `preemptible`. */
  followsSpotPrice: Schema.optional(
    Schema.Boolean.check(
      Validation.trueOnly(
        'pricing.followsSpotPrice',
        'the wire arm is an empty message (presence enables it) — to change the pricing mode set a different arm',
      ),
    ),
  ),
  /** A preemptible VM capped by a `PricingPolicy`'s max price (above it, the VM is preempted). */
  spotPricingPolicy: Schema.optional(
    Schema.Struct({
      /** The `PricingPolicy` that supplies the maximum agreed price. */
      id: BillingIds.PricingPolicyId,
    }),
  ),
}).check(exactlyOnePricingArm)

export type PricingModel = typeof PricingModelSchema.Type

/**
 * The API couples the pricing arm to the preemptibility of the VM — its own doc comment: *"Must match the
 * preemptible flag: on_demand for non-preemptible VMs, follows_spot_price or spot_pricing_policy for
 * preemptible VMs."* A mismatch is therefore a plan-time error here rather than an apply-time one.
 *
 * Two filters rather than one factory over a predicate, because "preemptible" is spelled two ways and a
 * generic `P extends { pricing?: PricingModel }` infers `P` from the *argument* rather than from the
 * `.check()` call site — which type-errors for all four callers:
 *
 *   - {@link pricingMatchesPresenceOnlyPreemptible} — the optional / presence-only spelling
 *     (`compute/v1 Instance.preemptible` is a message prop, `mk8s/v1 NodeTemplate.preemptible` an optional
 *     boolean switch), where "preemptible" means *present at all*;
 *   - {@link pricingMatchesBooleanPreemptible} — the required-boolean spelling
 *     (`ai/v1 {Job,Endpoint}.preemptible: boolean`), where it means `=== true`.
 *
 * Omitting `pricing` stays legal in both directions — that is the platform's default, not a gap.
 */
const pricingArmProblem = (
  pricing: PricingModel | undefined,
  preemptible: boolean,
  preemptibleProp: string,
): string | undefined => {
  if (pricing === undefined) return undefined
  const onDemand = pricing.onDemand !== undefined
  if (onDemand && preemptible) {
    return `pricing.onDemand requires a non-preemptible VM: drop \`${preemptibleProp}\`, or use followsSpotPrice/spotPricingPolicy (the API: "Must match the preemptible flag")`
  }
  if (!onDemand && !preemptible) {
    return `pricing.followsSpotPrice/spotPricingPolicy requires \`${preemptibleProp}\`: the API requires on_demand for non-preemptible VMs ("Must match the preemptible flag")`
  }
  return undefined
}

/** For a resource whose `preemptible` is an optional / presence-only prop: present at all means preemptible. */
export const pricingMatchesPresenceOnlyPreemptible = (preemptibleProp: string) =>
  Schema.makeFilter((props: { preemptible?: unknown; pricing?: PricingModel }) =>
    pricingArmProblem(props.pricing, props.preemptible !== undefined, preemptibleProp),
  )

/** For a resource whose `preemptible` is a required boolean: `true` means preemptible. */
export const pricingMatchesBooleanPreemptible = (preemptibleProp: string) =>
  Schema.makeFilter((props: { preemptible: boolean; pricing?: PricingModel }) =>
    pricingArmProblem(props.pricing, props.preemptible, preemptibleProp),
  )
