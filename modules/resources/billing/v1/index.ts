// Billing is **references**, not resources — for now: the family that matters here is the id, not a
// provider. The 2026-09-24 schema pin bump brought in `billing/v1 PricingPolicyService` (a full-CRUD,
// project-scoped, named resource) together with the `pricing_model` oneof on four spec messages whose
// `spotPricingPolicy.id` arm names a Pricing Policy. The four providers reference that id, so the brand
// has to exist and be reachable (`Nebius.billing.PricingPolicyId`) before any of them can take it — the
// same ordering AGENTS.md §"Branded IDs" requires ("add a brand for a new resource/entity **before**
// wiring its provider").
//
// Whether the family also deserves a provider is deliberately *not* decided here: the service is
// provider-shaped (Create/Get/GetByName/List/Update/Delete), but it is new, unprobed, and its billing
// semantics (what an auction bid means for a running VM) have not been measured at all. See TASKS.md
// §"the schema pin bump".
export { PricingPolicyId } from './ids.ts'
