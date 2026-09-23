// Capacity is **discovery + references**, not resources — and that is the API's
// shape, not a shortcut. Two of the three services have no create/update/delete
// at all and their specs are *empty messages* (`CapacityBlockGroupSpec`,
// `CapacityIntervalSpec`); the third (`CapacityAllowance`) has a `delete` that
// means "reset the limit to the platform default" and a `list` that includes
// rows nobody created, so a declarative provider would lie about destroy and give
// `alchemy unsafe nuke` a list-based delete to drive. Both decisions are
// documented at the code (`capacity-allowance.schema.ts`) and parked with the
// evidence in TASKS.md.
//
// So there is still no provider to register and nothing to add to
// `modules/Provider.ts` — but the family is no longer just the advisor: the
// block-group actions are what hand out the ids `reservationPolicy.reservationIds`
// takes, which is what made the `CapacityBlockGroupId` brand possible.
export * as action from './actions.ts'
export {
  CapacityBlockGroupAttributesSchema,
  toFriendlyAttributes as toFriendlyCapacityBlockGroup,
  type CapacityBlockGroupAttributes,
} from './capacity-block-group.schema.ts'
export {
  CapacityIntervalAttributesSchema,
  toFriendlyAttributes as toFriendlyCapacityInterval,
  type CapacityIntervalAttributes,
} from './capacity-interval.schema.ts'
export {
  CapacityAllowanceAttributesSchema,
  toFriendlyAttributes as toFriendlyCapacityAllowance,
  type CapacityAllowanceAttributes,
} from './capacity-allowance.schema.ts'
export {
  ResourceAdviceAttributesSchema,
  toFriendlyAttributes as toFriendlyResourceAdvice,
  type ResourceAdviceAttributes,
} from './resource-advice.schema.ts'
// Brand constructors as values, so callers holding a literal can brand it at that
// boundary (`CapacityBlockGroupId.make('capacityblockgroup-…')`).
export { CapacityBlockGroupId, CapacityIntervalId, CapacityAllowanceId } from './ids.ts'
