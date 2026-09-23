// Billing is a **references** family plus one resource: `PricingPolicy` is the project-scoped auction
// bid that the `pricing_model` oneof's `spot_pricing_policy { id }` arm names on `compute/v1 Instance`,
// `mk8s/v1 NodeTemplate` and `ai/v1 {Job,Endpoint}` — so the brand has to exist and be reachable
// (`Nebius.billing.PricingPolicyId`) before any of those props can take it, which is the ordering
// AGENTS.md §"Branded IDs" requires.
//
// The provider landed second (2026-09-24). It is the cheapest resource in the package to verify live —
// creating a policy provisions nothing — and it is the rare no-update-RPC case whose update path is
// *unimplemented on the wire* rather than merely unused (every documented `Update` shape answers a bare
// `3 INVALID_ARGUMENT: Request validation error`; see `api-client/billing.ts`), which is why every spec
// change is planned as a replace.
export { PricingPolicyId } from './ids.ts'
export {
  NebiusPricingPolicy as PricingPolicy,
  NebiusPricingPolicyProvider as PricingPolicyProvider,
  type NebiusPricingPolicy as PricingPolicyResource,
} from './pricing-policy.ts'
export {
  PricingPolicyAttributesSchema,
  PricingPolicyHasRunningVms,
  PricingPolicyPropsSchema,
  validatePricingPolicyProps,
  type PricingPolicyAttributes,
  type PricingPolicyProps,
} from './pricing-policy.schema.ts'
