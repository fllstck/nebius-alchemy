import * as BunTest from 'bun:test'
import * as Schema from 'effect/Schema'

import * as CapacityActions from '../../../modules/resources/capacity/v1/actions.ts'
import * as CapacitySchema from '../../../modules/resources/capacity/v1/resource-advice.schema.ts'
import * as NebiusResourceAdviceSchema from '../../../schemas/nebius/capacity/v1/resource_advice.ts'
import { runEffect } from '../../helpers/provider.ts'

const { describe, expect, test } = BunTest

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// Pure mapper + filter only. The `ListResourceAdvice` action itself is covered by
// `capacity.integration.test.ts`: an `Alchemy.Action` resolves through the stack
// (its output is an engine expression), so it cannot be called standalone — and
// importing the alchemy test harness into a plain unit file breaks the run.

const advice = (
  overrides: { region?: string; fabric?: string; platform?: string; preset?: string; available?: number } = {},
) =>
  NebiusResourceAdviceSchema.ResourceAdvice.fromJSON({
    metadata: { parentId: 'tenant-test-1' },
    spec: {
      region: overrides.region ?? 'eu-north1',
      fabric: overrides.fabric ?? 'fabric-7',
      computeInstance: {
        platform: overrides.platform ?? 'gpu-h200-sxm',
        preset: {
          name: overrides.preset ?? '8gpu-128vcpu-1600gb',
          resources: { vcpuCount: 128, memoryGibibytes: 1600, gpuCount: 8 },
        },
        gpuMemoryGigabytes: 1128,
      },
    },
    status: {
      onDemand: {
        dataState: NebiusResourceAdviceSchema.ResourceAdviceStatus_Availability_DataState.DATA_STATE_FRESH,
        available: overrides.available ?? 4,
        limit: 16,
        availabilityLevel:
          NebiusResourceAdviceSchema.ResourceAdviceStatus_Availability_AvailabilityLevel.AVAILABILITY_LEVEL_HIGH,
        effectiveAt: new Date('2026-09-19T10:00:00Z'),
      },
      preemptible: {
        dataState: NebiusResourceAdviceSchema.ResourceAdviceStatus_Availability_DataState.DATA_STATE_STALE,
        available: 0,
        limit: 16,
        availabilityLevel:
          NebiusResourceAdviceSchema.ResourceAdviceStatus_Availability_AvailabilityLevel.AVAILABILITY_LEVEL_LIMIT_REACHED,
      },
    },
  })

const mapped = (overrides: Parameters<typeof advice>[0] = {}) => CapacitySchema.toFriendlyAttributes(advice(overrides))

// ── Unit: the mapper ───────────────────────────────────────────────────────

describe('capacity advice → attributes', () => {
  test('exposes the fabric and the machine the advice applies to', () => {
    const row = mapped()
    expect(row.region).toBe('eu-north1')
    // The value `GpuCluster.infinibandFabric` wants.
    expect(row.fabric).toBe('fabric-7')
    expect(row.computeInstance?.platform).toBe('gpu-h200-sxm')
    expect(row.computeInstance?.preset?.name).toBe('8gpu-128vcpu-1600gb')
    expect(row.computeInstance?.preset?.resources).toEqual({
      vcpuCount: 128,
      memoryGibibytes: 1600,
      gpuCount: 8,
    })
    expect(row.computeInstance?.gpuMemoryGigabytes).toBe(1128)
  })

  test('availability keeps the numbers AND the enum names', () => {
    const row = mapped()
    expect(row.onDemand?.available).toBe(4)
    expect(row.onDemand?.limit).toBe(16)
    expect(row.onDemand?.dataState).toBe('DATA_STATE_FRESH')
    expect(row.onDemand?.availabilityLevel).toBe('AVAILABILITY_LEVEL_HIGH')
    expect(row.preemptible?.availabilityLevel).toBe('AVAILABILITY_LEVEL_LIMIT_REACHED')
    expect(row.onDemand?.effectiveAt).toEqual(new Date('2026-09-19T10:00:00Z'))
  })

  test('`available: 0` survives — the answer a caller is usually looking for', () => {
    // Regression guard for the mapping choice: the generic
    // `toFriendlyAttributes` would have dropped this, because the generated
    // `toJSON` omits zero-valued fields.
    expect(mapped().preemptible?.available).toBe(0)
  })

  test('an unspecified enum member maps to undefined, not to a fake name', () => {
    const row = NebiusResourceAdviceSchema.ResourceAdvice.fromJSON({
      spec: { region: 'eu-north1', fabric: 'fabric-7' },
      status: { onDemand: { available: 1, limit: 2 } },
    })
    const attrs = CapacitySchema.toFriendlyAttributes(row)
    expect(attrs.onDemand?.dataState).toBeUndefined()
    expect(attrs.onDemand?.availabilityLevel).toBeUndefined()
    expect(attrs.onDemand?.available).toBe(1)
  })

  test('a row with no status has no availability classes', () => {
    const attrs = CapacitySchema.toFriendlyAttributes(
      NebiusResourceAdviceSchema.ResourceAdvice.fromJSON({ spec: { region: 'eu-north1', fabric: 'fabric-7' } }),
    )
    expect(attrs.onDemand).toBeUndefined()
    expect(attrs.reserved).toBeUndefined()
    expect(attrs.preemptible).toBeUndefined()
  })

  test('the mapped row decodes against the attributes schema', async () => {
    const decoded = await runEffect(
      Schema.decodeUnknownEffect(CapacitySchema.ResourceAdviceAttributesSchema)(mapped()),
    )
    expect(decoded.fabric).toBe('fabric-7')
  })
})

// ── Unit: the client-side filter ───────────────────────────────────────────

describe('capacity advice filtering', () => {
  const rows = [
    mapped({ region: 'eu-north1', fabric: 'fabric-7', platform: 'gpu-h200-sxm' }),
    mapped({ region: 'eu-north1', fabric: 'fabric-7', platform: 'gpu-l40s-a', preset: '1gpu-8vcpu-32gb' }),
    mapped({ region: 'eu-west1', fabric: 'fabric-3', platform: 'gpu-h200-sxm' }),
  ]

  test('no filter returns everything', () => {
    expect(CapacityActions.filterResourceAdvice(rows, {})).toHaveLength(3)
  })

  test('filters by region, platform and preset', () => {
    expect(CapacityActions.filterResourceAdvice(rows, { region: 'eu-north1' }).map((r) => r.computeInstance?.platform)).toEqual([
      'gpu-h200-sxm',
      'gpu-l40s-a',
    ])
    expect(
      CapacityActions.filterResourceAdvice(rows, { region: 'eu-north1', platform: 'gpu-h200-sxm' }).map((r) => r.fabric),
    ).toEqual(['fabric-7'])
    expect(CapacityActions.filterResourceAdvice(rows, { preset: '1gpu-8vcpu-32gb' }).map((r) => r.region)).toEqual([
      'eu-north1',
    ])
  })

  test('an unmatched filter is an empty list, not an error', () => {
    expect(CapacityActions.filterResourceAdvice(rows, { region: 'us-central1' })).toEqual([])
  })

  test('deriving the available fabrics is a Set over the rows', () => {
    const fabrics = [...new Set(rows.map((r) => r.fabric))].sort()
    expect(fabrics).toEqual(['fabric-3', 'fabric-7'])
  })
})
