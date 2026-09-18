import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'

/**
 * ⚠️ UNVERIFIED against real infra, and gated on an input we cannot synthesize:
 * creating a GpuCluster needs the ID of a **physical InfiniBand fabric** in the
 * target region (`GpuClusterSpec.infinibandFabric`). No RPC in the generated
 * surface lists fabrics — the only place one is named is `capacity/v1` resource
 * advice, which is not implemented — so the id comes from the Nebius console
 * (GPU clusters → fabrics).
 *
 *   NEBIUS_TEST_INFINIBAND_FABRIC=<fabric> SLOW_TESTS=1 \
 *   bun test tests/resources/compute/v1/gpu-cluster.integration.test.ts
 *
 * Skipped (not deleted) so that having a fabric and GPU quota turns this into a
 * one-command verification. Until then, every claim about this provider rests on
 * the unit tests + the generated proto, not on a live deploy.
 */
const FABRIC = process.env.NEBIUS_TEST_INFINIBAND_FABRIC

integrationTest(
  test.provider,
  'Nebius.compute.v1.GpuCluster lifecycle',
  (stack) =>
    Effect.gen(function* () {
      const cluster = yield* stack.deploy(
        Nebius.compute.GpuCluster('LifecycleTest', { infinibandFabric: FABRIC! }),
      )

      expect(cluster.id).toBeDefined()
      expect(cluster.name).toBeDefined()
      expect(cluster.infinibandFabric).toBe(FABRIC!)
      // A brand-new cluster has no members — the state the delete guard relies on.
      expect(cluster.instances ?? []).toEqual([])
    }).pipe(safeDestroy(stack)),
  { timeout: 180_000 },
  FABRIC !== undefined,
)
