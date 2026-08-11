/**
 * Host-mode orphan cleanup: the lazily-declared children composed by
 * `transformInstanceProps` (per-stack assets bucket, binding identity, and
 * the DEDICATED fetch identity) must be orphaned + deleted when the instance
 * is removed from the stack.
 *
 * PLAN-ONLY — no cloud calls (asserting on the action graph, not applying
 * it), so this runs under plain `bun test` without `SLOW_TESTS`.
 *
 * Uses a minimal providers layer (collection + succeed layers only, NO
 * gRPC/auth layers) — planning resolves the action graph without executing
 * any lifecycle, so the deploy-side credentials are never needed. The orphan
 * pass runs against persisted state, so the second test seeds the scratch's
 * in-memory state with the rows the first plan declared, then re-plans the
 * EMPTY stack and asserts every row becomes a DELETE.
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { expect } from 'bun:test'
import * as Test from 'alchemy/Test/Bun'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as State from 'alchemy/State'
import * as Nebius from '@fllstck/nebius-alchemy'

import * as BucketResource from '../../../../modules/resources/storage/v1/bucket.ts'
import * as ServiceAccountResource from '../../../../modules/resources/iam/v1/service-account.ts'
import * as GroupResource from '../../../../modules/resources/iam/v1/group.ts'
import * as GroupMembershipResource from '../../../../modules/resources/iam/v1/group-membership.ts'
import * as AccessKeyResource from '../../../../modules/resources/iam/v2/access-key.ts'
import * as AccessPermitResource from '../../../../modules/resources/iam/v1/access-permit.ts'
import * as InstanceResource from '../../../../modules/resources/compute/v1/instance.ts'

class TestProviders extends AlchemyProvider.ProviderCollection<TestProviders>()('NebiusTest') {}

const planningProviders = () =>
  Layer.effect(
    TestProviders,
    AlchemyProvider.collection([
      BucketResource.NebiusBucket,
      ServiceAccountResource.NebiusServiceAccount,
      GroupResource.NebiusGroup,
      GroupMembershipResource.NebiusGroupMembership,
      AccessKeyResource.NebiusAccessKey,
      AccessPermitResource.NebiusAccessPermit,
      InstanceResource.NebiusInstance,
    ]),
  ).pipe(
    Layer.provideMerge(BucketResource.NebiusBucketProvider),
    Layer.provideMerge(ServiceAccountResource.NebiusServiceAccountProvider),
    Layer.provideMerge(GroupResource.NebiusGroupProvider),
    Layer.provideMerge(GroupMembershipResource.NebiusGroupMembershipProvider),
    Layer.provideMerge(AccessKeyResource.NebiusAccessKeyProvider),
    Layer.provideMerge(AccessPermitResource.NebiusAccessPermitProvider),
    Layer.provideMerge(InstanceResource.NebiusInstanceProvider),
  )

// oxlint-disable-next-line no-explicit-any — Test.make options are untyped (see tests/helpers/stack.ts)
const { test } = Test.make({ providers: planningProviders() as any })

const hostedInstanceProps = {
  serviceAccountId: 'sa-abc123',
  resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
  bootDisk: {
    attachMode: 'READ_WRITE',
    managedDisk: { name: 'boot-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 10 } },
  },
  networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0' }],
} as const

const hostedInstanceEffect = Effect.gen(function* () {
  yield* Nebius.compute.Instance('Api', { ...hostedInstanceProps, main: '/tmp/entry.ts' })
})

test.provider('Nebius.compute.v1.Instance host mode composes its identity', (stack) =>
  Effect.gen(function* () {
    const plan = yield* stack.plan(hostedInstanceEffect)

    const createdFqns = Object.entries(plan.resources)
      .filter(([, node]) => node.action === 'create')
      .map(([fqn]) => fqn)

    // The instance itself is namespaced under its logical id by transformProps.
    expect(createdFqns).toContain('Api')

    // Shared per-stack assets bucket (one per stack).
    expect(createdFqns.some((fqn) => fqn.includes('/HostedAssets-'))).toBe(true)

    // Binding identity (hostIdentity): SA + group + membership + key.
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiBindingSA'))).toBe(true)
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiBindingGroup'))).toBe(true)
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiBindingMembership'))).toBe(true)
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiBindingKey'))).toBe(true)

    // Dedicated read-only fetch identity: SA + group + membership + key.
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiHostedRuntimeSA'))).toBe(true)
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiHostedRuntimeGroup'))).toBe(true)
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiHostedRuntimeMembership'))).toBe(true)
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiHostedRuntimeKey'))).toBe(true)

    // Grants: upload (editor) + fetch (viewer) permits on the bucket.
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiHostedUploadAccess'))).toBe(true)
    expect(createdFqns.some((fqn) => fqn.endsWith('/ApiHostedFetchAccess'))).toBe(true)
  }),
)

test.provider('Nebius.compute.v1.Instance host mode orphans its identity on removal', (stack) =>
  Effect.gen(function* () {
    const stackSvc = yield* Alchemy.Stack

    // Pass 1 — plan the hosted instance and capture every composed FQN.
    const plan1 = yield* stack.plan(hostedInstanceEffect)
    const createdRows = Object.entries(plan1.resources).filter(([, node]) => node.action === 'create')

    // Seed the scratch's in-memory state with those rows (as if deployed).
    const state = yield* yield* State.State
    for (const [fqn, node] of createdRows) {
      yield* state.set({
        stack: stackSvc.name,
        stage: stackSvc.stage,
        fqn,
        value: {
          status: 'created',
          resourceType: node.resource.Type,
          namespace: undefined,
          fqn,
          logicalId: fqn.split('/').pop()!,
          instanceId: 'seeded-instance',
          providerVersion: 0,
          downstream: [],
          bindings: [],
          props: {},
          attr: {},
        } satisfies State.CreatedResourceState,
      })
    }

    // Pass 2 — the instance is REMOVED from the stack. Every persisted row
    // with no declaration is an orphan → the plan deletes it. Orphan deletes
    // land in `plan.deletions` (not `plan.resources`, which is the declared
    // graph — empty here).
    const plan2 = yield* stack.plan(Effect.void)
    const deletedFqns = Object.keys(plan2.deletions)

    expect(deletedFqns.sort()).toEqual(createdRows.map(([fqn]) => fqn).sort())
  }),
)

test.provider('Nebius.compute.v1.Instance low-level mode composes nothing', (stack) =>
  Effect.gen(function* () {
    const plan = yield* stack.plan(
      Effect.gen(function* () {
        yield* Nebius.compute.Instance('Plain', hostedInstanceProps)
      }),
    )
    const createdFqns = Object.entries(plan.resources)
      .filter(([, node]) => node.action === 'create')
      .map(([fqn]) => fqn)
    expect(createdFqns).toEqual(['Plain'])
  }),
)
