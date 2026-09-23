import * as Schema from 'effect/Schema'

// ---------------------------------------------------------------------------
// Branded IDs — capacity/v1
// ---------------------------------------------------------------------------
//
// One `ids.ts` per service version (AGENTS.md §"Branded IDs").
//
// The reason this file exists at all: `reservationPolicy.reservationIds` on
// `compute/v1 Instance` (and `mk8s/v1 NodeGroup`) names **Capacity Block
// Groups**, so a brand for that entity is what turns a bare `Schema.String`
// into a checked reference. That exception is now closed — see the doc comment
// on `ReservationPolicySchema` in `modules/resources/compute/v1/instance.schema.ts`.

/**
 * A **Capacity Block Group** — the reserved-capacity entity a
 * `reservationPolicy.reservationIds` entry names (in priority order).
 *
 * Measured live 2026-09-23: a non-existent id answers
 * `5 NOT_FOUND: Capacity Block Group (id=…) not found` from every scoped call
 * (`Get`, `ListResources`, `CapacityIntervalService/List`).
 *
 * No prefix check is attached, unlike `IamV2Ids.ProjectId`: this tenant has **no**
 * capacity block groups (see TASKS.md), so the real id shape was never
 * observed — only that the service validates and echoes it. Adding a
 * `capacityblockgroup-` refinement would be a guess.
 */
export const CapacityBlockGroupId = Schema.String.pipe(Schema.brand('CapacityBlockGroupId'))
export type CapacityBlockGroupId = typeof CapacityBlockGroupId.Type

/**
 * A **Capacity Interval** — one scheduled window of a Capacity Block Group
 * (`startTime`/`endTime`/`quantity`).
 *
 * Not addressable by the user: the service is read-only, and the parent is
 * always a Capacity Block Group. Branded anyway because it *is* an addressable
 * schema entity (`CapacityIntervalService/Get` takes an `id`), and a bare
 * `Schema.String` in an attribute is the thing this rule exists to prevent.
 */
export const CapacityIntervalId = Schema.String.pipe(Schema.brand('CapacityIntervalId'))
export type CapacityIntervalId = typeof CapacityIntervalId.Type

/**
 * A **Capacity Allowance** — the per-`(project, block group)` quota limit, as
 * returned by `CapacityAllowanceService`.
 *
 * Deliberately branded even though no provider manages it (see
 * `capacity-allowance.schema.ts` for why this family is discovery-only): the
 * value is a real resource id in `metadata.id`, and the alternative — a bare
 * string in an attribute — is exactly what §"Branded IDs" forbids.
 */
export const CapacityAllowanceId = Schema.String.pipe(Schema.brand('CapacityAllowanceId'))
export type CapacityAllowanceId = typeof CapacityAllowanceId.Type
