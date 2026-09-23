import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import * as CapacityActions from '../../../modules/resources/capacity/v1/actions.ts'
import * as CapacityBlockGroupSchema from '../../../modules/resources/capacity/v1/capacity-block-group.schema.ts'
import * as CapacityIntervalSchema from '../../../modules/resources/capacity/v1/capacity-interval.schema.ts'
import * as CapacityAllowanceSchema from '../../../modules/resources/capacity/v1/capacity-allowance.schema.ts'
import { CapacityBlockGroupId } from '../../../modules/resources/capacity/v1/ids.ts'
import * as NebiusCapacityBlockGroupSchema from '../../../schemas/nebius/capacity/v1/capacity_block_group.ts'
import * as NebiusCapacityIntervalSchema from '../../../schemas/nebius/capacity/v1/capacity_interval.ts'
import * as NebiusCapacityAllowanceSchema from '../../../schemas/nebius/capacity/v1/capacity_allowance.ts'
import {
  capacityAllowanceListRequest,
  capacityBlockGroupListRequest,
  capacityIntervalListRequest,
} from '../../../modules/api-client/capacity.ts'
import { runEffect } from '../../helpers/provider.ts'

const { describe, expect, test } = BunTest

// Branded ids are compared through `String(...)`. The brand is a compile-time
// refinement, so `expect(row.id).toBe('literal')` is a type error by design
// (AGENTS.md §"Branded IDs — everywhere": "branded props reject string
// literals in typed callers"). The value under test is the id itself, so
// widening it at the assertion is the honest comparison — the same reason the
// repo's other tests call `.make()` on literals.

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// Pure mappers + client-side filters only. The actions themselves are covered by
// `capacity.integration.test.ts`: an `Alchemy.Action` resolves through the stack
// (its output is an engine expression), so it cannot be called standalone.
//
// The *measured* shapes from the 2026-09-23 live probe
// (`spikes/capacity-blocks-probe.ts`) are the empty ones: this tenant holds no
// capacity block groups, so every scoped call answered
// `5 NOT_FOUND: Capacity Block Group (id=…) not found` and every list answered
// `items: []`. The populated fixtures below therefore encode the proto's
// **documented** semantics — which is where the int64/enum/zero-value hazards
// live — and not a live sample. There is no live sample to encode; that is the
// finding, and it is why the live test asserts emptiness instead of a row.

const blockGroup = (
  overrides: {
    id?: string
    region?: string
    fabric?: string
    platform?: string
    state?: number
    usageState?: number
    currentLimit?: string
    usage?: string
    reconcicling?: boolean
    interval?: { quantity: string; state: number } | undefined
  } = {},
) =>
  NebiusCapacityBlockGroupSchema.CapacityBlockGroup.fromJSON({
    metadata: { id: overrides.id ?? 'capacityblockgroup-e00abc123' },
    status: {
      region: overrides.region ?? 'eu-north1',
      resourceAffinity: {
        computeV1: { fabric: overrides.fabric ?? 'fabric-7', platform: overrides.platform ?? 'gpu-h200-sxm' },
      },
      service: 'compute',
      state: overrides.state ?? NebiusCapacityBlockGroupSchema.CapacityBlockGroupStatus_State.STATE_ACTIVE,
      usageState:
        overrides.usageState ?? NebiusCapacityBlockGroupSchema.CapacityBlockGroupStatus_UsageState.USAGE_STATE_USED,
      currentLimit: overrides.currentLimit ?? '8',
      usage: overrides.usage ?? '2',
      usagePercentage: '25',
      nextChangeAt: '2026-10-01T00:00:00Z',
      ...(overrides.interval === undefined
        ? {}
        : {
            currentContinuousInterval: {
              startTime: '2026-09-01T00:00:00Z',
              endTime: '2026-10-01T00:00:00Z',
              quantity: overrides.interval.quantity,
              state: overrides.interval.state,
            },
          }),
      reconciling: overrides.reconcicling ?? false,
    },
  })

const mappedBlockGroup = (overrides: Parameters<typeof blockGroup>[0] = {}) =>
  CapacityBlockGroupSchema.toFriendlyAttributes(blockGroup(overrides))

/**
 * A block group with no affinity — a real shape, not a defensive case: the
 * advisor returns rows without a fabric too (14 of 38, measured 2026-09-23; the
 * ratio moves with the tenant's live capacity).
 */
const affinitylessBlockGroup = (id: string, region = 'eu-north1') =>
  CapacityBlockGroupSchema.toFriendlyAttributes(
    NebiusCapacityBlockGroupSchema.CapacityBlockGroup.fromJSON({
      metadata: { id },
      status: { region, currentLimit: '0', usage: '0' },
    }),
  )

/** One capacity allowance row, with the limit/state/name under test. */
const allowance = (overrides: { limit?: string; state?: number; name?: string } = {}) =>
  NebiusCapacityAllowanceSchema.CapacityAllowance.fromJSON({
    metadata: {
      id: 'capacityallowance-e00xyz',
      parentId: 'project-e00eq4g7pr00j746m1fttd',
      ...(overrides.name === undefined ? {} : { name: overrides.name }),
    },
    spec: {
      capacityBlockGroupId: 'capacityblockgroup-e00abc123',
      ...(overrides.limit === undefined ? {} : { limit: overrides.limit }),
    },
    status: {
      state: overrides.state ?? NebiusCapacityAllowanceSchema.CapacityAllowanceStatus_State.STATE_ACTIVE,
      usage: '2',
      usagePercentage: '25',
      usageState: NebiusCapacityAllowanceSchema.CapacityAllowanceStatus_UsageState.USAGE_STATE_USED,
      unit: 'GPU',
      reconciling: false,
    },
  })

// ── Unit: Capacity Block Group mapping ─────────────────────────────────────

describe('capacity block group → attributes', () => {
  test('exposes the branded id `reservationIds` takes, plus the affinity', () => {
    const row = mappedBlockGroup()
    // The whole point of this family: a branded id, and the (fabric, platform)
    // triple `resourceAdvice` also reports.
    expect(String(row.id)).toBe('capacityblockgroup-e00abc123')
    expect(row.region).toBe('eu-north1')
    expect(row.resourceAffinity).toEqual({ fabric: 'fabric-7', platform: 'gpu-h200-sxm' })
    expect(row.service).toBe('compute')
  })

  test('int64 quota fields arrive as decimal strings, not numbers', () => {
    // `currentLimit`/`usage`/`quantity` are `Long` on the wire. The advice rows
    // next door are `number` (int32) — so this is per-field, not per-service
    // (AGENTS.md §"Resource Lifecycle Details").
    const row = mappedBlockGroup({ currentLimit: '8', usage: '2', interval: { quantity: '8', state: 2 } })
    expect(row.currentLimit).toBe('8')
    expect(row.usage).toBe('2')
    expect(row.currentContinuousInterval?.quantity).toBe('8')
  })

  test('a zero limit and zero usage survive — they are the answer, not an absence', () => {
    // The reason this mapper is hand-written instead of
    // `ResourceUtils.toFriendlyAttributes`: the JSON overlay omits zero fields,
    // so `"0"` would vanish. "You hold this reservation but may use none of it"
    // is exactly what a caller needs to see.
    const row = mappedBlockGroup({ currentLimit: '0', usage: '0' })
    expect(row.currentLimit).toBe('0')
    expect(row.usage).toBe('0')
  })

  test('enum members come back as their proto names', () => {
    const row = mappedBlockGroup({ interval: { quantity: '8', state: 2 } })
    expect(row.state).toBe('STATE_ACTIVE')
    expect(row.usageState).toBe('USAGE_STATE_USED')
    expect(row.currentContinuousInterval?.state).toBe(
      NebiusCapacityBlockGroupSchema.currentContinuousInterval_StateToJSON(2),
    )
  })

  test('an unspecified enum maps to undefined, never to a fake name', () => {
    const attrs = CapacityBlockGroupSchema.toFriendlyAttributes(
      NebiusCapacityBlockGroupSchema.CapacityBlockGroup.fromJSON({
        metadata: { id: 'capacityblockgroup-x' },
        status: { region: 'eu-north1', currentLimit: '1', usage: '0' },
      }),
    )
    expect(attrs.state).toBeUndefined()
    expect(attrs.usageState).toBeUndefined()
    // …while the numbers are still present.
    expect(attrs.currentLimit).toBe('1')
    expect(attrs.usage).toBe('0')
  })

  test('a group with no affinity and no interval maps cleanly', () => {
    const attrs = affinitylessBlockGroup('capacityblockgroup-x')
    expect(attrs.resourceAffinity).toBeUndefined()
    expect(attrs.currentContinuousInterval).toBeUndefined()
    expect(attrs.nextChangeTo).toBeUndefined()
    expect(attrs.reconciling).toBe(false)
  })

  test('the mapped row decodes against the attributes schema', async () => {
    const decoded = await runEffect(
      Schema.decodeUnknownEffect(CapacityBlockGroupSchema.CapacityBlockGroupAttributesSchema)(mappedBlockGroup()),
    )
    expect(decoded.id).toBe('capacityblockgroup-e00abc123')
  })
})

// ── Unit: block group filtering (client-side; `List` takes no filter) ──────

describe('capacity block group filtering', () => {
  const rows = [
    mappedBlockGroup({ id: 'capacityblockgroup-a', region: 'eu-north1', fabric: 'fabric-7' }),
    mappedBlockGroup({ id: 'capacityblockgroup-b', region: 'eu-west1', fabric: 'fabric-3', platform: 'gpu-l40s-a' }),
    affinitylessBlockGroup('capacityblockgroup-c'),
  ]

  test('no filter returns everything, including rows without an affinity', () => {    expect(CapacityActions.filterCapacityBlockGroups(rows, {})).toHaveLength(3)
  })

  test('filters by region, fabric and platform', () => {
    expect(CapacityActions.filterCapacityBlockGroups(rows, { region: 'eu-north1' }).map((r) => String(r.id))).toEqual([
      'capacityblockgroup-a',
      'capacityblockgroup-c',
    ])
    expect(CapacityActions.filterCapacityBlockGroups(rows, { fabric: 'fabric-7' }).map((r) => String(r.id))).toEqual([
      'capacityblockgroup-a',
    ])
    expect(CapacityActions.filterCapacityBlockGroups(rows, { platform: 'gpu-l40s-a' }).map((r) => String(r.id))).toEqual([
      'capacityblockgroup-b',
    ])
  })

  test('an affinity filter excludes a group the API left without one', () => {
    // Deliberate, and worth pinning: a caller filtering by fabric is asking for
    // a reservation *for that fabric*, and a group with no affinity is not an
    // answer. Unfiltered, it is still listed.
    expect(CapacityActions.filterCapacityBlockGroups(rows, { fabric: 'fabric-7' })).toHaveLength(1)
    expect(CapacityActions.filterCapacityBlockGroups(rows, { region: 'eu-north1' })).toHaveLength(2)
  })

  test('an unmatched filter is an empty list, not an error', () => {
    expect(CapacityActions.filterCapacityBlockGroups(rows, { fabric: 'fabric-nope' })).toEqual([])
  })

  test('deriving reservationIds keeps the priority order', () => {
    // The documented use: ids in priority order for
    // `reservationPolicy: { policy: 'STRICT', reservationIds }`.
    const reservationIds = CapacityActions.filterCapacityBlockGroups(rows, { region: 'eu-north1' }).map((r) =>
      String(r.id),
    )
    expect(reservationIds).toEqual(['capacityblockgroup-a', 'capacityblockgroup-c'])
  })
})

// ── Unit: Capacity Interval mapping ────────────────────────────────────────

describe('capacity interval → attributes', () => {
  test('maps the window, the quantity (int64 → string) and the state', () => {
    const attrs = CapacityIntervalSchema.toFriendlyAttributes(
      NebiusCapacityIntervalSchema.CapacityInterval.fromJSON({
        metadata: { id: 'capacityinterval-e00xyz' },
        status: {
          containerId: 'tenant-e00xt8cvv67054nhsj',
          region: 'eu-north1',
          resourceAffinity: { computeV1: { fabric: 'fabric-7', platform: 'gpu-h200-sxm' } },
          service: 'compute',
          quantity: '8',
          startTime: '2026-09-01T00:00:00Z',
          endTime: '2026-10-01T00:00:00Z',
          state: NebiusCapacityIntervalSchema.CapacityIntervalStatus_State.STATE_ACTIVE,
          reconciling: true,
        },
      }),
    )
    expect(String(attrs.id)).toBe('capacityinterval-e00xyz')
    expect(String(attrs.containerId)).toBe('tenant-e00xt8cvv67054nhsj')
    expect(attrs.quantity).toBe('8')
    expect(attrs.state).toBe('STATE_ACTIVE')
    expect(attrs.startTime).toEqual(new Date('2026-09-01T00:00:00Z'))
    expect(attrs.endTime).toEqual(new Date('2026-10-01T00:00:00Z'))
    expect(attrs.reconciling).toBe(true)
  })

  test('an interval with no container id omits it rather than branding an empty string', () => {
    // `IamV2Ids.TenantId` has no refinement, so `''` would pass `.make()` — and
    // would then be a fabricated id in an attribute. Omitted instead.
    const attrs = CapacityIntervalSchema.toFriendlyAttributes(
      NebiusCapacityIntervalSchema.CapacityInterval.fromJSON({
        metadata: { id: 'capacityinterval-x' },
        status: { region: 'eu-north1', quantity: '0' },
      }),
    )
    expect(attrs.containerId).toBeUndefined()
    // A zero quantity is preserved: an interval that reserves nothing is a real
    // state (a scheduled cancellation).
    expect(attrs.quantity).toBe('0')
  })

  test('zero-state intervals report no state name', () => {
    const attrs = CapacityIntervalSchema.toFriendlyAttributes(
      NebiusCapacityIntervalSchema.CapacityInterval.fromJSON({
        metadata: { id: 'capacityinterval-x' },
        status: { region: 'eu-north1', quantity: '1' },
      }),
    )
    expect(attrs.state).toBeUndefined()
  })
})

// ── Unit: Capacity Allowance mapping ───────────────────────────────────────

describe('capacity allowance → attributes', () => {
  test('maps the (project, block group) pair and the unit', () => {
    const attrs = CapacityAllowanceSchema.toFriendlyAttributes(allowance({ limit: '8', name: 'gpu-reservation' }))
    expect(String(attrs.id)).toBe('capacityallowance-e00xyz')
    expect(String(attrs.parentId)).toBe('project-e00eq4g7pr00j746m1fttd')
    expect(attrs.name).toBe('gpu-reservation')
    expect(String(attrs.capacityBlockGroupId)).toBe('capacityblockgroup-e00abc123')
    expect(attrs.limit).toBe('8')
    expect(attrs.unit).toBe('GPU')
    expect(attrs.state).toBe('STATE_ACTIVE')
    expect(attrs.usage).toBe('2')
  })

  test('an omitted limit means UNLIMITED — it must not collapse into "0"', () => {
    // The proto: "Optional is used to define an unlimited Capacity Allowance."
    // `undefined` and `"0"` are therefore different answers; conflating them
    // would turn "no limit" into "no capacity".
    expect(CapacityAllowanceSchema.toFriendlyAttributes(allowance()).limit).toBeUndefined()
    expect(CapacityAllowanceSchema.toFriendlyAttributes(allowance({ limit: '0' })).limit).toBe('0')
  })

  test('the container-deleted state is reported, not treated as absent', () => {
    const attrs = CapacityAllowanceSchema.toFriendlyAttributes(
      allowance({
        state: NebiusCapacityAllowanceSchema.CapacityAllowanceStatus_State.STATE_CONTAINER_DELETED,
      }),
    )
    expect(attrs.state).toBe('STATE_CONTAINER_DELETED')
  })

  test('a default (never-created) row still maps — presence is not ownership', () => {
    // The proto says `List` includes non-created allowances "showing the default
    // limit". Such a row has no id and no limit, and mapping it is what makes
    // "compare against the default" possible for a caller.
    const attrs = CapacityAllowanceSchema.toFriendlyAttributes(
      NebiusCapacityAllowanceSchema.CapacityAllowance.fromJSON({
        metadata: { parentId: 'project-e00eq4g7pr00j746m1fttd' },
        spec: { capacityBlockGroupId: 'capacityblockgroup-e00abc123' },
      }),
    )
    expect(String(attrs.id)).toBe('')
    expect(attrs.limit).toBeUndefined()
    expect(attrs.usage).toBe('0')
  })
})

// ── Unit: pagination request shapes ────────────────────────────────────────
//
// `pageSize: 100` was probed as ACCEPTED by all four list endpoints
// (`spikes/capacity-blocks-probe.ts`). That is not a safe default to assume:
// `nvl-instance-group` rejects 100 while its compute neighbours accept it, which
// is why `tests/api-client/nvl-instance-group-list.test.ts` exists.

describe('capacity pagination requests', () => {
  test('block groups paginate by TENANT with pageSize 100', () => {
    const request = capacityBlockGroupListRequest('tenant-e00xt8cvv67054nhsj', '')
    expect(request.parentId).toBe('tenant-e00xt8cvv67054nhsj')
    expect(request.pageSize.toNumber()).toBe(100)
  })

  test('intervals paginate by BLOCK GROUP, not by tenant', () => {
    // The API rejects a tenant here: "parent_id: Value error, Expected
    // capacityblockgroup type but got tenant" (probed).
    const request = capacityIntervalListRequest('capacityblockgroup-e00abc123', '')
    expect(request.parentId).toBe('capacityblockgroup-e00abc123')
    expect(request.pageSize.toNumber()).toBe(100)
  })

  test('allowances paginate by PROJECT', () => {
    const request = capacityAllowanceListRequest('project-e00eq4g7pr00j746m1fttd', '')
    expect(request.parentId).toBe('project-e00eq4g7pr00j746m1fttd')
    expect(request.pageSize.toNumber()).toBe(100)
  })

  test('the page token is carried through for paging', () => {
    expect(capacityBlockGroupListRequest('tenant-1', 'token-2').pageToken).toBe('token-2')
    expect(capacityIntervalListRequest('capacityblockgroup-1', 'token-2').pageToken).toBe('token-2')
    expect(capacityAllowanceListRequest('project-1', 'token-2').pageToken).toBe('token-2')
  })
})

// ── Unit: the `reservationIds` prop is now branded ─────────────────────────
//
// This is what the whole capacity slice was for. `InstanceProps.reservationPolicy
// .reservationIds` accepted bare strings because no capacity brand existed; it
// now takes `CapacityBlockGroupId`.

describe('instance.reservationPolicy.reservationIds branding', () => {
  test('accepts a list of ids and brands each one', async () => {
    const decoded = await runEffect(
      Schema.decodeUnknownEffect(Schema.Array(CapacityBlockGroupId))([
        'capacityblockgroup-a',
        'capacityblockgroup-b',
      ]),
    )
    expect(decoded.map(String)).toEqual(['capacityblockgroup-a', 'capacityblockgroup-b'])
  })

  test('rejects a non-string entry', async () => {
    const failure = await runEffect(
      Schema.decodeUnknownEffect(Schema.Array(CapacityBlockGroupId))([42]).pipe(Effect.flip),
    )
    expect(failure).toBeDefined()
  })

  test('the brand is exported as a value, for callers holding a literal', () => {
    expect(String(CapacityBlockGroupId.make('capacityblockgroup-literal'))).toBe('capacityblockgroup-literal')
  })
})
