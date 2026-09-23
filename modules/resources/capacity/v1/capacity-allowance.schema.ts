import * as Schema from 'effect/Schema'

import * as NebiusCapacityAllowanceSchema from '../../../../schemas/nebius/capacity/v1/capacity_allowance.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'
import { CapacityAllowanceId, CapacityBlockGroupId } from './ids.ts'

// ---------------------------------------------------------------------------
// Capacity Allowance attributes
// ---------------------------------------------------------------------------
//
// The one *mutable* member of the capacity family, and deliberately still
// discovery-only — there is no provider. Three measured/documented properties
// make a declarative resource unsafe to ship:
//
// 1. **`delete` is not a delete.** The proto: *"Resets Capacity Allowance limit
//    to the default value."* An `alchemy destroy` would therefore not remove
//    anything, while reporting success — the opposite of the `makeCrudDelete`
//    contract ("a hand-written `delete` MUST treat `NOT_FOUND` as success", and
//    implicitly must actually delete).
// 2. **The row can pre-exist `create`.** `List` is documented to include
//    *"non-created Capacity Allowances as well for clarity, showing the default
//    limit"*, and `GetByParentAndCapacityBlockGroup` has no create requirement.
//    So "observe, then create if missing" (the house `reconcile` shape) would
//    adopt a platform default row as if this stack had made it — and ownership
//    tagging has nothing to tag, the pair is implicit.
// 3. **`list` is the `nuke` surface.** `alchemy unsafe nuke` enumerates through
//    each provider's `list` and deletes what it finds. If the service ever
//    returns non-created rows for a tenant that *has* block groups (unverifiable
//    here — this tenant has none), that delete is "reset to default" for every
//    `(project, block group)` pair in the tenant.
//
// Read-only exposure has none of those hazards and still answers the useful
// question ("what limit does this project have on that block group?"). A
// provider is parked in TASKS.md with this reasoning rather than invented.
//
// Hand-mapped like its two siblings: zero values (`usage: "0"`, the state enums)
// are answers, and the JSON overlay would drop them.

export const CapacityAllowanceAttributesSchema = Schema.Struct({
  id: CapacityAllowanceId,
  /** The project the allowance belongs to (`metadata.parent_id`). */
  parentId: Schema.optional(IamV2Ids.ProjectId),
  /** `metadata.name`, when the API assigns one. */
  name: Schema.optional(Schema.String),
  /** The Capacity Block Group the limit applies to. */
  capacityBlockGroupId: CapacityBlockGroupId,
  /**
   * Total resources allocated, int64 → decimal **string**. **Omitted means
   * unlimited** — the proto documents this explicitly, so `undefined` and `"0"`
   * are different answers and must not be collapsed.
   */
  limit: Schema.optional(Schema.String),
  /** `STATE_PROVISIONING` / `STATE_ACTIVE` / `STATE_CONTAINER_DELETED`. */
  state: Schema.optional(Schema.String),
  /** Current usage, int64 → decimal **string**. */
  usage: Schema.String,
  /** Usage as a percentage — already a string on the wire. */
  usagePercentage: Schema.String,
  /** `USAGE_STATE_USED` / `USAGE_STATE_NOT_USED` / `USAGE_STATE_UNKNOWN`. */
  usageState: Schema.optional(Schema.String),
  /** Unit of the limit, e.g. `"GPU"`. */
  unit: Schema.String,
  /** The API reports an in-flight change. */
  reconciling: Schema.Boolean,
})

export type CapacityAllowanceAttributes = typeof CapacityAllowanceAttributesSchema.Type

/** Zero enum member (`STATE_UNSPECIFIED`) → `undefined`. */
const enumName = (value: number | undefined, toName: (v: number) => string): string | undefined =>
  value === undefined || value === 0 ? undefined : toName(value)

/** Friendly attributes for one Capacity Allowance. */
export const toFriendlyAttributes = (
  raw: NebiusCapacityAllowanceSchema.CapacityAllowance,
): CapacityAllowanceAttributes => {
  const status = raw.status
  const parentId = raw.metadata?.parentId
  const name = raw.metadata?.name

  return {
    id: CapacityAllowanceId.make(raw.metadata?.id ?? ''),
    parentId: parentId ? IamV2Ids.ProjectId.make(parentId) : undefined,
    name: name ? name : undefined,
    capacityBlockGroupId: CapacityBlockGroupId.make(raw.spec?.capacityBlockGroupId ?? ''),
    limit: raw.spec?.limit === undefined ? undefined : raw.spec.limit.toString(),
    state: enumName(status?.state, NebiusCapacityAllowanceSchema.capacityAllowanceStatus_StateToJSON),
    usage: status?.usage?.toString() ?? '0',
    usagePercentage: status?.usagePercentage ?? '',
    usageState: enumName(
      status?.usageState,
      NebiusCapacityAllowanceSchema.capacityAllowanceStatus_UsageStateToJSON,
    ),
    unit: status?.unit ?? '',
    reconciling: status?.reconciling ?? false,
  }
}
