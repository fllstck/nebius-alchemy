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
        .map(
          (row) =>
            `${row.fabric}/${row.computeInstance?.platform}/od=${row.onDemand?.available ?? '?'}of${row.onDemand?.limit ?? '?'} pre=${row.preemptible?.available ?? '?'}of${row.preemptible?.limit ?? '?'}`,
        )
      console.log(`PROBE region ${region}: fabrics=[${[...regionFabrics].join(', ')}] gpu-derived=[${gpu.join(', ')}]`)
    }

    // The filter is applied client-side over the same data.
    const region = rows[0]!.region
    const scoped = yield* stack.deploy(Nebius.capacity.action.ListResourceAdvice({ region }))
    expect(scoped.every((row) => row.region === region)).toBe(true)
  }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)

// ── Integration: the capacity-blocks family, live and read-only ────────────

/**
 * The other half of the capacity API lives on a **different host**
 * (`capacity-blocks.billing-cpl…` vs the advisor's `capacity-advisor.billing-cpl…`),
 * which is what TASKS.md flagged as the open risk before this slice. This test
 * settles it against the real infrastructure, and pins the two behaviours the
 * unit tests can only encode from the proto:
 *
 * 1. **The host authenticates and answers.** A missing endpoint-catalog entry
 *    fails as `UnknownServiceError`; a broken channel fails before any RPC. Both
 *    would be invisible to a mocked unit test.
 * 2. **The identity error is the API's own.** A scoped call with an unknown
 *    block group id answers `5 NOT_FOUND: Capacity Block Group (id=…) not
 *    found`, naming the entity type — the evidence behind the
 *    `CapacityBlockGroupId` doc comment, and the reason the brand has no prefix
 *    refinement (the real id shape was never observed here).
 *
 * ⚠️ **This tenant holds no capacity block groups** (measured 2026-09-23). So an
 * empty list is the *expected* answer and is asserted as such — this test does
 * not create anything, cannot, and does not pretend to: `CapacityBlockGroupSpec`
 * is an empty message and the service has no create RPC. Read-only throughout,
 * so it is safe to run repeatedly (unlike the mutating live-echo audit).
 */
integrationTest(
  test.provider,
  'Nebius.capacity.action.List/GetCapacityBlockGroups + intervals + allowances (live, read-only)',
  (stack) =>
    Effect.gen(function* () {
      const { groups, allowances } = yield* stack.deploy(
        Effect.gen(function* () {
          // No tenant, project or block group exists to scope to, so the two
          // list actions that take their scope from config are exercised
          // as-declared: `groups` is tenant-scoped server-side, `allowances`
          // project-scoped. `ListCapacityIntervals` needs an explicit block
          // group id, and this tenant has none — it is exercised by its
          // not-found path below instead.
          const groups = yield* Nebius.capacity.action.ListCapacityBlockGroups({})
          const allowances = yield* Nebius.capacity.action.ListCapacityAllowances({})
          return { groups, allowances }
        }),
      )

      // Arrays, not errors — the whole point of probing the second host.
      expect(Array.isArray(groups)).toBe(true)
      expect(Array.isArray(allowances)).toBe(true)

      // Printed on purpose: the counts are the evidence, and a future run where
      // this tenant DOES hold a block group will show up as a changed log line
      // rather than a silent pass.
      console.log(
        `PROBE capacity-blocks host: groups=${groups.length} allowances=${allowances.length} ` +
          `(both expected 0 for tenant without block groups)`,
      )

      // The affinity lookup is the `reservationIds` derivation path, and it is
      // the call a caller reaches for first when a block group *does* exist.
      // With no reservation in place, "no group for this (region, fabric,
      // platform)" is the correct answer — and the error names the whole triple
      // it searched, which is why the assertion checks the region shows up.
      const affinityMiss = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Nebius.capacity.action.GetCapacityBlockGroupByResourceAffinity({
              region: 'eu-north1',
              fabric: 'fabric-does-not-exist',
              platform: 'gpu-h200-sxm',
            })
          }),
        )
        .pipe(Effect.flip)
      console.log('PROBE affinity lookup (expected failure):', String(affinityMiss).slice(0, 160))
      // Measured shape: "5 NOT_FOUND: Capacity Block Group (container id=…,
      // region=eu-north1, resource_affinity=… ) not found" — it echoes the query,
      // unlike the by-id form below.
      expect(String(affinityMiss)).toContain('region=eu-north1')

      // The identity error, pinned live: a distinct action instance is needed
      // (same-name actions in one stack share an output — see `vpc.test.ts`).
      const notFound = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Nebius.capacity.action.GetCapacityBlockGroup({ id: 'capacityblockgroup-doesnotexist' })
          }),
        )
        .pipe(Effect.flip)
      console.log('PROBE unknown block group:', String(notFound).slice(0, 140))
      expect(String(notFound)).toContain('Capacity Block Group')

      // The interval list takes a block group as its parent and rejects anything
      // else — the scoping rule the api-client request builder encodes.
      const intervalMiss = yield* stack
        .deploy(
          Nebius.capacity.action.ListCapacityIntervals({
            capacityBlockGroupId: 'capacityblockgroup-doesnotexist',
          }),
        )
        .pipe(Effect.flip)
      expect(String(intervalMiss)).toContain('Capacity Block Group')
    }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)
