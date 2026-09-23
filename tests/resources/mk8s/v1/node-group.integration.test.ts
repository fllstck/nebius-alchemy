import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import Long from 'long'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as Mk8sGrpc from '../../../../modules/api-client/mk8s.ts'
import * as Ids from '../../../../modules/resources/iam/v1/ids.ts'

// ── Integration: Nebius.mk8s.v1.NodeGroup, live ────────────────────────────
//
// Self-contained: it brings its own network, subnet, service account and grant, so it
// needs no tenant-specific ids. The stack is network → subnet → cluster → node group,
// with the identity chain (SA → group → `editor` permit → membership) beside it because
// the node template's `serviceAccountId` is what lets nodes pull images and call the API.
//
// ⚠️ **This test provisions a real VM.** The node group creates a compute instance and
// waits for it to join the cluster, so it costs minutes and real quota — more than the
// Cluster's own test, which only needs a control plane.
//
// ## What this test is really guarding
//
// The convergence sweep proves the drift list is wired up; only a real API can show it does
// not **loop**. `NodeGroup` is the resource where that risk is highest: `NodeTemplate` is 17
// fields of 12 nested messages, the API has **no `FieldMask`**, and it answers with its own
// materialized values (`maxPods: 110` per the proto). A drift list that compared the whole
// template would write on every reconcile, forever.
//
// So the second deploy changes `labels` — a props change `diff` ignores, which therefore runs
// `reconcile` — and asserts `metadata.resourceVersion` did not move. `resourceVersion` is a
// per-resource write counter that starts at `1` for this type (calibrated 2026-09-23; both
// mk8s types count, unlike `iam/**` which exposes no counter at all).
//
// `version` is deliberately **omitted**: inheriting the cluster's resolved version is the
// recommended configuration and the one a drift check is most likely to get wrong. The
// pinned-version comparison is unit-covered (`nodeGroupSpecDrifted`).

integrationTest(
  test.provider,
  'Nebius.mk8s.v1.NodeGroup lifecycle (+ no-drift-on-reconcile)',
  (stack) =>
    Effect.gen(function* () {
      // The stack provides the gRPC services, so a raw read needs no layer wiring —
      // same idiom as `live-echo.integration.test.ts`.
      const mk8s = yield* Mk8sGrpc.Mk8sGrpcService
      const projectId = yield* Config.String('NEBIUS_PROJECT_ID')

      // `etcdClusterSize: 1` keeps the control plane non-HA and cheap (the Cluster test's
      // measurement); the node group itself is the expensive half.
      const declare = (labels?: Record<string, string>) =>
        Effect.gen(function* () {
          const network = yield* Nebius.vpc.Network('Mk8sNg-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('Mk8sNg-Subnet', { networkId: network.id })

          // The identity chain the node template needs: an SA with an `editor` grant on the
          // project, via a throwaway group + permit (the pattern the AccessPermit live test
          // uses with `viewer`; `editor` is what carries registry/API access).
          const sa = yield* Nebius.iam.ServiceAccount('Mk8sNg-SA', { description: 'mk8s node group test' })
          const group = yield* Nebius.iam.Group('Mk8sNg-Group', {})
          yield* Nebius.iam.AccessPermit('Mk8sNg-Permit', {
            parentId: group.id,
            resourceId: Ids.AccessPermitResourceId.make(projectId),
            role: 'editor',
          })
          yield* Nebius.iam.GroupMembership('Mk8sNg-Membership', { parentId: group.id, memberId: sa.id })

          const cluster = yield* Nebius.mk8s.Cluster('Mk8sNg-Cluster', {
            subnetId: subnet.id,
            etcdClusterSize: 1,
          })
          const nodeGroup = yield* Nebius.mk8s.NodeGroup('Mk8sNg-NodeGroup', {
            parentId: cluster.id,
            fixedNodeCount: 1,
            // The measured working shape (2026-09-23): cpu-d3 + 2vcpu-8gb + one node +
            // ubuntu24.04. 64 GiB is the platform's boot-disk floor (a smaller disk never
            // reaches cloud-init, so provisioning hangs with no diagnostic).
            template: {
              os: 'ubuntu24.04',
              resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
              bootDisk: { sizeGibibytes: 64, type: 'NETWORK_SSD' },
              networkInterfaces: [{ subnetId: subnet.id }],
              serviceAccountId: sa.id,
              cloudInitUserData: '#cloud-config\n',
            },
            ...(labels === undefined ? {} : { labels }),
          })
          return { cluster, nodeGroup }
        })

      const { nodeGroup } = yield* stack.deploy(declare())

      expect(nodeGroup.id).toBeDefined()
      expect(typeof nodeGroup.id).toBe('string')
      // The node group is only RUNNING once its nodes have joined — this is the assertion
      // the VM spend buys.
      expect(nodeGroup.state).toBe('RUNNING')
      expect(nodeGroup.fixedNodeCount).toBe('1')
      expect(nodeGroup.nodeCount).toBe('1')
      expect(nodeGroup.readyNodeCount).toBe('1')
      // Inherited from the cluster: `status.version` is the *node image* version — measured
      // live 2026-09-23 as `v1.36.3-nebius-node.75`, i.e. a **different format with a leading
      // `v`**, which is why `requestedVersion` is undefined here and nowhere compares the two.
      expect(nodeGroup.requestedVersion).toBeUndefined()
      expect(nodeGroup.version).toMatch(/^v\d+\.\d+\.\d+-nebius-node\.\d+$/)

      // Live-echo assertion 1: a create-only deploy wrote exactly once.
      const created = yield* mk8s.nodeGroup.get(nodeGroup.id)
      const createdVersion = created.metadata?.resourceVersion?.toString()
      expect(createdVersion).toBe('1')

      console.log(
        `PROBE mk8s node group: id=${nodeGroup.id} state=${nodeGroup.state} ` +
          `requestedVersion=${nodeGroup.requestedVersion ?? '(omitted)'} version=${nodeGroup.version} ` +
          `nodeCount=${nodeGroup.nodeCount} readyNodeCount=${nodeGroup.readyNodeCount} ` +
          `resourceVersion=${createdVersion}`,
      )
      // The platform's own view of the spec, which is what the drift check compares against.
      // **Print values, not just keys** — the first run of this test printed
      // `Object.keys`-style output and therefore could not say whether the API had filled in
      // `template.maxPods` (the proto documents `110`) or `spec.version` (which appears in the
      // echo even when the props omit it). Every field here that the props did not pin is
      // evidence for the `pinnedSpecDeepEqual` design.
      const render = (value: unknown): string =>
        // `spec` is a **proto message**: `spec.toJSON()` is the JSON rendering the API and
        // `toFriendlyAttributes` use (Long → decimal string, enum → name). Longs nested in
        // plain objects/arrays are covered by the replacer.
        JSON.stringify(value, (_key, nested) => (Long.isLong(nested) ? nested.toString() : nested))
      console.log(
        `PROBE mk8s node group spec echo: ` +
          JSON.stringify({
            version: render(created.spec?.version),
            fixedNodeCount: render(created.spec?.fixedNodeCount),
            template: Object.fromEntries(
              Object.entries(created.spec?.template ?? {})
                .filter(([, value]) => value !== undefined)
                // User-data is not a secret *here*, but it can be one in general.
                .map(([key, value]) => [key, key === 'cloudInitUserData' ? '<user-data>' : render(value)]),
            ),
          }),
      )

      // ── Live-echo assertion 2: a forced reconcile writes nothing ────────────
      // `labels` is create-time only (no update path sends labels), so adding one is a props
      // change `diff` ignores → the framework plans `action: update` → reconcile RUNS. It must
      // then find no drift: every optional template field the props omit must be invisible to
      // the comparison, or this writes on every pass forever.
      const redeployed = yield* stack.deploy(declare({ 'alchemy-test': 'forced-reconcile' }))
      const afterReconcile = yield* mk8s.nodeGroup.get(redeployed.nodeGroup.id)

      expect(
        afterReconcile.metadata?.resourceVersion?.toString(),
        'reconcile re-wrote the node group: a drift-list entry is comparing an omitted prop against ' +
          'the API echo (see AGENTS.md §Convergence, and the `omits`/unit-test rows for ' +
          '`blockSizeBytes`, `resources.preset`, `networkInterfaces` and the materialized `maxPods`)',
      ).toBe('1')
      // Same node group — no replace was planned either.
      expect(afterReconcile.metadata?.id).toBe(nodeGroup.id)
    }).pipe(safeDestroy(stack)),
  // Cluster (~3 min) + node group provisioning and node join + a forced reconcile + destroy,
  // with headroom: a node group is the slowest thing this suite creates.
  { timeout: 2_400_000 },
)
