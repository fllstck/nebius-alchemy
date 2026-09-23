import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as Mk8sGrpc from '../../../../modules/api-client/mk8s.ts'

// ── Integration: Nebius.mk8s.v1.Cluster, live ──────────────────────────────
//
// Self-contained: it brings its own network + subnet, so it needs no
// tenant-specific ids and it exercises the dependency chain the provider will
// actually see (network → subnet → cluster), including the teardown order.
//
// `etcdClusterSize: 1` keeps it non-HA and cheap — verified legal 2026-09-23
// (`1`/`3`/`5` are the accepted values; 3 is the default). A 1-etcd cluster
// reached `RUNNING` in ~3 min.
//
// ## What this test is really guarding
//
// The convergence sweep proves the *drift list* is wired up; only a real API can
// show it does not **loop**. So the second half re-deploys with a `labels` change —
// a props change `diff` ignores, which therefore runs `reconcile` — and asserts
// `metadata.resourceVersion` did not move. `resourceVersion` is a per-resource write
// counter that starts at `1` for this type (measured 2026-09-23), so it is the same
// oracle `tests/helpers/live-echo.ts` uses: a version that climbs without a props
// change means reconcile is re-writing the API's own echo on every pass.
//
// This is the direction that made `filesystem.blockSizeBytes`,
// `transfer.{limiters,interIterationInterval}` and `record.ttl` unsafe, and mk8s is a
// fresh hand-written drift list — the highest-risk shape there is.

integrationTest(
  test.provider,
  'Nebius.mk8s.v1.Cluster lifecycle (+ no-drift-on-reconcile)',
  (stack) =>
    Effect.gen(function* () {
      // The stack provides the gRPC services, so a raw read needs no layer wiring —
      // same idiom as `live-echo.integration.test.ts`.
      const mk8s = yield* Mk8sGrpc.Mk8sGrpcService

      const { cluster, subnet } = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Nebius.vpc.Network('Mk8sTest-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('Mk8sTest-Subnet', { networkId: network.id })
          // No `version` on purpose: omitting it is the recommended configuration (the
          // backend picks), and it is the case a drift check is most likely to get wrong.
          const cluster = yield* Nebius.mk8s.Cluster('Mk8sTest-Cluster', {
            subnetId: subnet.id,
            etcdClusterSize: 1,
          })
          return { cluster, subnet }
        }),
      )

      expect(cluster.id).toBeDefined()
      expect(typeof cluster.id).toBe('string')
      expect(cluster.state).toBe('RUNNING')
      // The control plane resolved a version even though none was requested…
      expect(cluster.version).toBeDefined()
      // …and the requested side stays absent, which is what keeps `spec`-vs-`desired`
      // comparable instead of permanently drifted.
      expect(cluster.requestedVersion).toBeUndefined()
      expect(cluster.subnetId).toBe(subnet.id)
      expect(cluster.etcdClusterSize).toBe('1')

      // Live-echo assertion 1: a create-only deploy wrote exactly once.
      const created = yield* mk8s.cluster.get(cluster.id)
      expect(created.metadata?.resourceVersion?.toString()).toBe('1')

      console.log(
        `PROBE mk8s cluster: id=${cluster.id} state=${cluster.state} ` +
          `requestedVersion=${cluster.requestedVersion ?? '(omitted)'} version=${cluster.version} ` +
          `resourceVersion=${created.metadata?.resourceVersion?.toString()}`,
      )

      // ── Live-echo assertion 2: a forced reconcile writes nothing ────────────
      // `labels` is create-time only (no update path sends labels), so adding one is a
      // props change `diff` ignores → the framework plans `action: update` → reconcile
      // RUNS. It must then find no drift: the optional props the props omit must not be
      // compared against anything, or this writes on every pass forever.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Nebius.vpc.Network('Mk8sTest-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('Mk8sTest-Subnet', { networkId: network.id })
          const cluster = yield* Nebius.mk8s.Cluster('Mk8sTest-Cluster', {
            subnetId: subnet.id,
            etcdClusterSize: 1,
            labels: { 'alchemy-test': 'forced-reconcile' },
          })
          return { cluster, subnet }
        }),
      )

      const afterReconcile = yield* mk8s.cluster.get(redeployed.cluster.id)

      expect(
        afterReconcile.metadata?.resourceVersion?.toString(),
        'reconcile re-wrote the cluster: a drift-list entry is comparing an omitted prop ' +
          'against the API echo (see AGENTS.md §Convergence and the omits rows in tests/convergence.test.ts)',
      ).toBe('1')
      // The cluster is still the same one — no replace was planned either.
      expect(afterReconcile.metadata?.id).toBe(cluster.id)
    }).pipe(safeDestroy(stack)),
  // Create (~3 min for 1 etcd) + a forced reconcile + destroy, with headroom.
  { timeout: 1_200_000 },
)
