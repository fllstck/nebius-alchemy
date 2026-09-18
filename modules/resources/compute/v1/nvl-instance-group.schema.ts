import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// Domain validations
// ---------------------------------------------------------------------------

/** `size` is a *maximum*, and a group of zero instances cannot be created. */
const sizeValid = Schema.makeFilter((size: number) =>
  Number.isInteger(size) && size > 0 ? undefined : `size must be a positive integer, got "${size}"`,
)

// ---------------------------------------------------------------------------
// NVLInstanceGroup Props (user input)
// ---------------------------------------------------------------------------

/**
 * Type of the NVLink instance group — mirrors
 * `NVLInstanceGroupSpec.NVLInstanceGroupType` (spelled from the schema).
 * `UNSPECIFIED` is deliberately absent: it means "not set", which the API
 * rejects on create.
 */
export const NVLInstanceGroupTypeSchema = Schema.Union([Schema.Literal('GB200'), Schema.Literal('GB300')])

export const NVLInstanceGroupPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * The NVLink platform this group is provisioned for. Immutable — changing the
   * type replaces the group (see the provider's `diff`).
   */
  type: NVLInstanceGroupTypeSchema,
  /** Maximum number of instances in the group. Adjustable in place. */
  size: Schema.Finite.check(sizeValid),
})

export type NVLInstanceGroupProps = typeof NVLInstanceGroupPropsSchema.Type

export const validateNVLInstanceGroupProps = Validation.makeValidateProps(NVLInstanceGroupPropsSchema)

// ---------------------------------------------------------------------------
// NVLInstanceGroup Attributes (output)
// ---------------------------------------------------------------------------

export const NVLInstanceGroupAttributesSchema = Schema.Struct({
  id: Ids.NVLInstanceGroupId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Enum name from the schema (e.g. `GB200`) — the JSON form of an int32 on the wire. */
  type: Schema.String,
  /** int64 on the wire, so the JSON form is a decimal string (see `toFriendlyAttributes`). */
  size: Schema.String,
  /**
   * Attached instances keyed by instance ID, each with its current state
   * (read-only). Membership is declared on the Instance
   * (`nvlInstanceGroupId`) — the group has no members field of its own.
   */
  instances: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ instanceState: Schema.String }))),
  /** Whether an operation is in flight on the group. */
  reconciling: Schema.optional(Schema.Boolean),
})

export type NVLInstanceGroupAttributes = typeof NVLInstanceGroupAttributesSchema.Type
