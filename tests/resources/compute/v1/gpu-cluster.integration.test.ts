import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import { expect } from 'bun:test'
import type { ScratchStack } from 'alchemy/Test/Bun'
import { Nebius, test } from '../../../helpers/stack.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import * as ComputeGrpc from '../../../../modules/api-client/compute.ts'
import type { ResourceAdviceAttributes } from '../../../../modules/resources/capacity/v1/resource-advice.schema.ts'

/**
 * Live `GpuCluster` lifecycle — **verified 2026-09-18**: create 1.6 s, fabric
 * round-trip, delete 3.2 s, no leak, no GPU quota, no cost (see TASKS.md
 * §"fabric discovery").
 *
 * `NEBIUS_TEST_INFINIBAND_FABRIC` is an optional **override**. Without it the
 * test discovers a fabric itself — project's region (from config, resolved off
 * the stored profile exactly as the providers do) → the capacity advisor's
 * advice for that region → the first non-empty fabric. That is the same path a
 * user follows, which is what makes this test self-sufficient.
 */
const FABRIC = process.env.NEBIUS_TEST_INFINIBAND_FABRIC

/**
 * Discover a fabric the way a user would: the project's region (from config —
 * `NEBIUS_REGION`, supplied by the stored profile, with the same `eu-north1`
 * fallback the hosted-runtime path uses) → the capacity advisor's advice for that
 * region → the first non-empty fabric (advice rows are not all fabric-scoped).
 *
 * The advice call is its OWN `stack.deploy`: inside a deploy body an action
 * resolves to an expression whose members are still Outputs (its `length` is an
 * `Output<number>`), so the value can only be used here, not there.
 */
const discoverFabric = (stack: ScratchStack) =>
  Effect.gen(function* () {
    const region = yield* Config.String('NEBIUS_REGION').pipe(Config.withDefault('eu-north1'))
    const rows: ReadonlyArray<ResourceAdviceAttributes> = yield* stack.deploy(
      Nebius.capacity.action.ListResourceAdvice({ region }),
    )
    const fabric = rows.map((row) => row.fabric).find((candidate) => candidate !== '')
    if (fabric === undefined) {
      return yield* Effect.fail(new Error(`no InfiniBand fabric advertised for region ${region}`))
    }
    console.log(`PROBE discovered fabric ${fabric} for region ${region}`)
    return fabric
  })

/**
 * Post-destroy leak verification **by id** (no parent needed, so it works
 * without `NEBIUS_PROJECT_ID`): a destroyed cluster must stop resolving.
 * `GpuClusterStatus` has no state/deletedAt field — unlike buckets, deletion is
 * hard and immediate (measured: gone within 5 s) — so "reaped" can only mean
 * `get` → NOT_FOUND. Poll for it, then fail with the id, which is the one thing
 * needed to clean up by hand:
 * `nebius compute gpu-cluster delete --id <id>`.
 */
const verifyNoGpuClusterLeak = (id: () => string | undefined) =>
  Effect.gen(function* () {
    const clusterId = id()
    if (clusterId === undefined) return // the body failed before creating it
    const compute = yield* ComputeGrpc.ComputeGrpcService

    const isGone = () =>
      compute.gpuCluster
        .get(clusterId)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(true) : Effect.fail(e))))
        .pipe(Effect.map((result) => result === true))

    for (let attempt = 0; attempt < 12; attempt++) {
      if (yield* isGone()) return
      yield* Effect.sleep(5_000)
    }
    return yield* Effect.fail(
      new Error(
        `LEAKED GpuCluster ${clusterId} is still readable 60s after destroy — clean up with: nebius compute gpu-cluster delete --id ${clusterId}`,
      ),
    )
  })

integrationTest(
  test.provider,
  'Nebius.compute.v1.GpuCluster lifecycle',
  (stack) => {
    // Declared OUTSIDE the effect: the leak verification is constructed before
    // the body runs and executed after destroy, so it needs a live handle on the
    // id, not a snapshot of it.
    let createdId: string | undefined

    return Effect.gen(function* () {
      const fabric = FABRIC ?? (yield* discoverFabric(stack))
      const cluster = yield* stack.deploy(
        Nebius.compute.GpuCluster('LifecycleTest', { infinibandFabric: fabric }),
      )
      createdId = cluster.id

      // Printed so a failed run leaves the cleanup handle in the output.
      console.log(`PROBE GpuCluster created: id=${cluster.id} name=${cluster.name} fabric=${fabric}`)

      expect(cluster.id).toBeDefined()
      expect(cluster.name).toBeDefined()
      // The round-trip IS the identity proof: the API accepted a fabric id that
      // came from `capacity/v1` resource advice.
      expect(cluster.infinibandFabric).toBe(fabric)
      // A brand-new cluster has no members — the state the delete guard relies on.
      expect(cluster.instances ?? []).toEqual([])
    }).pipe(safeDestroy(stack, verifyNoGpuClusterLeak(() => createdId)))
  },
  { timeout: 180_000 },
)
