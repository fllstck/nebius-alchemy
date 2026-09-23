import * as Schema from 'effect/Schema'

// ---------------------------------------------------------------------------
// Branded IDs — billing/v1
// ---------------------------------------------------------------------------
//
// One `ids.ts` per service version (AGENTS.md §"Branded IDs").
//
// Why this file exists: the `pricing_model` oneof that the 2026-09-24 schema pin bump brought in
// (`buf.gen.yaml` -> ca9fcdc) has an arm `spotPricingPolicy { id }` on **four** spec messages —
// `compute/v1 InstanceSpec`, `mk8s/v1 NodeTemplate`, `ai/v1 JobSpec` and `ai/v1 EndpointSpec` — and that
// `id` names a **Pricing Policy**, a project-scoped billing resource. Without a brand, the one arm of
// the oneof that carries a value would be the only place in this package where a real Nebius resource id
// travels as a bare `Schema.String`.
//
// The endpoint for that resource (its own full-CRUD service, `billing/v1 PricingPolicyService`) is mapped
// in `modules/endpoints.ts` from the upstream catalog at the pinned commit:
// `pricing-policies.billing-cpl.api.nebius.cloud:443`.

/**
 * A **Pricing Policy** — the project-scoped billing entity a
 * `pricing.spotPricingPolicy.id` names: an auction bid (a max price per GPU for a given platform) that
 * ranks a preemptible VM for scheduling and preemption.
 *
 * Deliberately **no prefix refinement**, the same decision as
 * `capacity/v1`'s `CapacityBlockGroupId`: nothing in this tenant was ever observed creating one, so the
 * real id shape (`pricingpolicy-…`?) is a guess. What *is* known is that the field is validated
 * server-side and that the parent is a project, which is a permission-scoping fact rather than an
 * id-shape one.
 *
 * A **provider** for the family is a separate, unstarted decision: the service really does have
 * Create/Get/GetByName/List/Update/Delete and a project-scoped named spec, so it is provider-shaped —
 * see TASKS.md §"the schema pin bump".
 */
export const PricingPolicyId = Schema.String.pipe(Schema.brand('PricingPolicyId'))
export type PricingPolicyId = typeof PricingPolicyId.Type
