import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../helpers/stack.ts'
import { integrationTest } from '../../helpers/gate.ts'
import { safeDestroy } from '../../helpers/cleanup.ts'

// ── Integration: the RPC, live ─────────────────────────────────────────────

/**
 * Read-only live check. This is step 1 of the `GpuCluster` fabric probe (see
 * TASKS.md): it proves the advice call works against the real advisor, that the
 * tenant has at least one fabric, and it prints the fabric set plus a sample row
 * — which is the input step 2 (creating a `GpuCluster` with a discovered fabric,
 * the step that decides whether `ResourceAdviceSpec.fabric` and
 * `GpuClusterSpec.infinibandFabric` are really the same namespace) starts from.
 *
 * No mutation and no quota: it only lists.
 */
integrationTest(test.provider, 'Nebius.capacity.action.ListResourceAdvice (live, read-only)', (stack) =>
  Effect.gen(function* () {
    const rows = yield* stack.deploy(Nebius.capacity.action.ListResourceAdvice({}))

    expect(rows.length).toBeGreaterThan(0)

    // NOTE: not every row is fabric-scoped — real responses include rows with an
    // empty `fabric` (non-InfiniBand / CPU platforms). Discovery filters those out.
    const fabrics = [...new Set(rows.map((row) => row.fabric).filter((fabric) => fabric !== ''))]
    expect(fabrics.length).toBeGreaterThan(0)

    // Printed on purpose: this is what the GpuCluster probe consumes.
    console.log('PROBE rows:', rows.length, '· rows without a fabric:', rows.filter((r) => r.fabric === '').length)
    console.log('PROBE fabrics:', JSON.stringify(fabrics))
    const byRegion = new Map<string, Set<string>>()
    for (const row of rows) {
      if (row.fabric === '') continue
      const set = byRegion.get(row.region) ?? new Set<string>()
      set.add(row.fabric)
      byRegion.set(row.region, set)
    }
    for (const [region, regionFabrics] of byRegion) {
      const gpu = rows
        .filter((row) => row.region === region && row.fabric !== '' && (row.computeInstance?.gpuMemoryGigabytes ?? 0) > 0)
        .map((row) => `${row.fabric}/${row.computeInstance?.platform}/${row.onDemand?.available ?? '?'}avail`)
      console.log(`PROBE region ${region}: fabrics=[${[...regionFabrics].join(', ')}] gpu-derived=[${gpu.join(', ')}]`)
    }

    // The filter is applied client-side over the same data.
    const region = rows[0]!.region
    const scoped = yield* stack.deploy(Nebius.capacity.action.ListResourceAdvice({ region }))
    expect(scoped.every((row) => row.region === region)).toBe(true)
  }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)
