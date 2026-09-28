import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Path from 'effect/Path'
import { NodeFileSystem } from '@effect/platform-node'
import * as Module from '../../../../modules/resources/compute/v1/instance.ts'
import * as Hosted from '../../../../modules/resources/compute/v1/hosted.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/instance.schema.ts'
import * as IamIds from '../../../../modules/resources/iam/v1/ids.ts'
import * as VpcIds from '../../../../modules/resources/vpc/v1/ids.ts'
import * as BillingIds from '../../../../modules/resources/billing/v1/ids.ts'
import { GpuClusterId, InstanceId } from '../../../../modules/resources/compute/v1/ids.ts'
import * as NebiusInstanceSchema from '../../../../schemas/nebius/compute/v1/instance.ts'
import { GrpcError } from '../../../../modules/api-client/grpc-utils.ts'
import {
  readInput,
  resolveProvider,
  runDiff,
  runDiffExpectingError,
  runReconcileExpectingError,
  runEffect,
  diffInput,
} from '../../../helpers/provider.ts'
import {
  instanceIdLayer,
  mockComputeLayer,
  protoMetadata,
  recordingLogs,
  recordingSession,
  stackLayer,
} from '../../../helpers/mocks.ts'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

const { describe, expect, test } = BunTest

/**
 * R-09 — a VM that fails to boot is a *runtime outcome*, so it is raised as a catchable tagged error
 * rather than as a defect (which reports as a crash and cannot be `catchTag`'d).
 *
 * Both branches are driven through the real function: the timeout via `deadlineMs: 0` (the seam exists
 * for exactly this — 15 minutes of wall clock is not a unit test), and the `ERROR` state via a mocked
 * `instance.get`. The `mockComputeLayer` is empty for the timeout case because the deadline is already
 * past when the loop starts — no call is made.
 */
describe('Nebius.compute.v1.Instance waitForInstanceState failures (R-09)', () => {
  const session = { note: () => Effect.void }
  const instanceId = InstanceId.make('computeinstance-e00testinstanceid')

  test('a timeout is InstanceStartTimeoutError, and catchTag recovers', async () => {
    const recovered = await runEffect(
      Module.waitForInstanceState({ instanceId, targetStates: ['RUNNING'], session, deadlineMs: 0 }).pipe(
        Effect.catchTag('InstanceStartTimeoutError', (error) =>
          Effect.succeed(`timed out after ${error.targetStates.join('/')}`),
        ),
        Effect.provide(mockComputeLayer({})),
      ),
    )

    expect(recovered).toBe('timed out after RUNNING')
  })

  test('an ERROR state is InstanceUnhealthyError, and catchTag recovers', async () => {
    const recovered = await runEffect(
      Module.waitForInstanceState({ instanceId, targetStates: ['RUNNING'], session }).pipe(
        Effect.catchTag('InstanceUnhealthyError', (error) => Effect.succeed(`unhealthy: ${error.state}`)),
        Effect.provide(
          mockComputeLayer({ instance: { get: () => Effect.succeed({ status: { state: 'ERROR' } }) } }),
        ),
      ),
    )

    expect(recovered).toBe('unhealthy: ERROR')
  })
})

/**
 * R-08 — the reconcile phases, unit-tested directly.
 *
 * `reconcile` used to be one 341-line generator, so every behaviour below was only observable through the
 * provider's front door. These tests drive the extracted phases (`ensureCreated`, `applyUpdate`,
 * `ensureRunning`; `waitForInstanceState` has its own block above) against `mockComputeLayer`, so the
 * request each phase sends and the call order it sends them in are the assertion.
 */
describe('Nebius.compute.v1.Instance reconcile phases (R-08)', () => {
  /** A raw proto instance with only the fields the phases read. */
  const protoInstance = (overrides: Record<string, unknown> = {}) => ({
    metadata: protoMetadata('computeinstance-abc123', 'vm-1', 'project-1'),
    spec: { stopped: false, serviceAccountId: 'serviceaccount-abc123' },
    status: {},
    ...overrides,
  })

  const desiredFrom = (overrides: Record<string, unknown> = {}) =>
    NebiusInstanceSchema.InstanceSpec.fromJSON({
      resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
      serviceAccountId: 'serviceaccount-abc123',
      bootDisk: { attachMode: 'READ_WRITE', managedDisk: { name: 'boot-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 64 } } },
      ...overrides,
    })

  /**
   * The phases receive **validated** props — `reconcile` runs `validateInstanceProps` before calling any of
   * them — so the fixtures go through the same schema once instead of being cast around its brands.
   */
  const phaseProps = (overrides: Record<string, unknown> = {}) =>
    Schema.decodeUnknownSync(SchemaModule.InstancePropsSchema)({ ...validInstanceProps, ...overrides })

  /** The layers `ensureCreated` needs: the service, plus the naming context (`createPhysicalName`). */
  const createLayers = (compute: unknown) => Layer.mergeAll(mockComputeLayer(compute), instanceIdLayer, stackLayer)

  describe('ensureCreated', () => {
    test('creates with a generated physical name and the merged ownership labels', async () => {
      const requests: Array<unknown> = []
      const session = recordingSession()
      const created = protoInstance()

      const result = await runEffect(
        Module.ensureCreated({
          id: 'test-id',
          news: phaseProps({ labels: { team: 'platform' } }),
          desired: desiredFrom(),
          parentId: 'project-1',
          labels: { 'alchemy::id': 'test-id', 'alchemy::stack': 'test-stack', team: 'platform' },
          session: session.session,
        }).pipe(
          Effect.provide(
            createLayers({
              instance: {
                create: (req: unknown) => {
                  requests.push(req)
                  return Effect.succeed(created)
                },
              },
            }),
          ),
        ),
      )

      expect(result).toBe(created)
      const request = requests[0] as { metadata: { name: string; parentId: string; labels: Record<string, string> } }
      expect(request.metadata.parentId).toBe('project-1')
      // A generated name: non-empty, and the engine's instance id seeds it, so it is stable per deploy.
      expect(request.metadata.name.length).toBeGreaterThan(0)
      expect(request.metadata.labels).toEqual({
        'alchemy::id': 'test-id',
        'alchemy::stack': 'test-stack',
        team: 'platform',
      })
      expect(session.messages().some((m) => m.includes('Creating Nebius.compute.v1.Instance'))).toBe(true)
    })

    test('a pinned name is sent verbatim', async () => {
      const requests: Array<unknown> = []
      await runEffect(
        Module.ensureCreated({
          id: 'test-id',
          news: phaseProps({ name: 'vm-pinned' }),
          desired: desiredFrom(),
          parentId: 'project-1',
          labels: {},
          session: recordingSession().session,
        }).pipe(
          Effect.provide(
            createLayers({
              instance: {
                create: (req: unknown) => {
                  requests.push(req)
                  return Effect.succeed(protoInstance())
                },
              },
            }),
          ),
        ),
      )

      expect((requests[0] as { metadata: { name: string } }).metadata.name).toBe('vm-pinned')
    })

    test('a create failure that can hide a success ADOPTS the instance found by name', async () => {
      const session = recordingSession()
      const recovered = protoInstance()

      const result = await runEffect(
        Module.ensureCreated({
          id: 'test-id',
          news: phaseProps({ name: 'vm-pinned' }),
          desired: desiredFrom(),
          parentId: 'project-1',
          labels: {},
          session: session.session,
        }).pipe(
          Effect.provide(
            createLayers({
              instance: {
                // ABORTED (10) is in `CREATE_RECOVERY_CODES`: the operation may have been applied.
                create: () => Effect.fail(new GrpcError({ code: 10, message: 'aborted', details: '' })),
                getByName: () => Effect.succeed(recovered),
              },
            }),
          ),
        ),
      )

      expect(result).toBe(recovered)
      // The adoption is narrated: without this line an operator cannot tell a recovered create from a
      // create that simply worked.
      expect(session.messages().some((m) => m.includes('Recovered Nebius.compute.v1.Instance'))).toBe(true)
    })

    test('a NOT_FOUND recovery lookup re-raises the ORIGINAL create error', async () => {
      const error = await runEffect(
        Effect.flip(
          Module.ensureCreated({
            id: 'test-id',
            news: phaseProps({ name: 'vm-pinned' }),
            desired: desiredFrom(),
            parentId: 'project-1',
            labels: {},
            session: recordingSession().session,
          }).pipe(
            Effect.provide(
              createLayers({
                instance: {
                  create: () => Effect.fail(new GrpcError({ code: 10, message: 'aborted', details: '' })),
                  // The resource is genuinely absent — the create failure is the useful report.
                  getByName: () => Effect.fail(new GrpcError({ code: 5, message: 'not found', details: '' })),
                },
              }),
            ),
          ),
        ),
      )

      expect((error as { code: number }).code).toBe(10)
    })

    test('a failure that CANNOT hide a success never triggers the lookup', async () => {
      let lookups = 0
      const error = await runEffect(
        Effect.flip(
          Module.ensureCreated({
            id: 'test-id',
            news: phaseProps({ name: 'vm-pinned' }),
            desired: desiredFrom(),
            parentId: 'project-1',
            labels: {},
            session: recordingSession().session,
          }).pipe(
            Effect.provide(
              createLayers({
                instance: {
                  // INVALID_ARGUMENT (3): the create provably did not land, so a lookup can only produce a
                  // wrong diagnosis (R-20).
                  create: () => Effect.fail(new GrpcError({ code: 3, message: 'invalid argument', details: '' })),
                  getByName: () => {
                    lookups += 1
                    return Effect.succeed(protoInstance())
                  },
                },
              }),
            ),
          ),
        ),
      )

      expect((error as { code: number }).code).toBe(3)
      expect(lookups).toBe(0)
    })

    test('a lookup that fails for another reason warns and reports the original create failure', async () => {
      const logs = recordingLogs()
      const error = await runEffect(
        Effect.flip(
          Module.ensureCreated({
            id: 'test-id',
            news: phaseProps({ name: 'vm-pinned' }),
            desired: desiredFrom(),
            parentId: 'project-1',
            labels: {},
            session: recordingSession().session,
          }).pipe(
            Effect.provide(
              createLayers({
                instance: {
                  create: () => Effect.fail(new GrpcError({ code: 10, message: 'aborted', details: '' })),
                  // A rotated/expired credential: the lookup could not answer, which must be audible rather
                  // than read as "no instance there" (R-02's class).
                  getByName: () => Effect.fail(new GrpcError({ code: 7, message: 'PermissionDenied', details: '' })),
                },
              }),
            ),
          ),
        ).pipe(Effect.provide(logs.layer)),
      )

      expect((error as { code: number }).code).toBe(10)
      expect(logs.messages().some((m) => m.includes('7 PermissionDenied') && m.includes('vm-pinned'))).toBe(true)
    })
  })

  describe('applyUpdate', () => {
    test('no drift and no label change writes nothing, and returns the observed instance', async () => {
      let updates = 0
      // The live spec IS the desired spec (the same object), which is what "no drift" means — a fixture
      // with a thinner spec would legitimately drift on the fields the props pin.
      const live = protoInstance({ spec: desiredFrom() })

      const result = await runEffect(
        Module.applyUpdate({
          instance: live as never,
          news: phaseProps(),
          olds: undefined,
          desired: desiredFrom(),
          parentId: 'project-1',
          labels: {},
          session: recordingSession().session,
        }).pipe(
          Effect.provide(
            mockComputeLayer({
              instance: {
                update: () => {
                  updates += 1
                  return Effect.succeed(live)
                },
              },
            }),
          ),
        ),
      )

      expect(result).toBe(live)
      expect(updates).toBe(0)
    })

    test('a spec drift updates with parentId, resourceVersion and the merged labels', async () => {
      const requests: Array<unknown> = []
      const updated = protoInstance({ spec: { serviceAccountId: 'serviceaccount-new' } })

      const result = await runEffect(
        Module.applyUpdate({
          instance: protoInstance() as never,
          news: phaseProps(),
          olds: undefined,
          desired: desiredFrom({ serviceAccountId: 'serviceaccount-new' }),
          parentId: 'project-9',
          labels: { 'alchemy::id': 'test-id' },
          session: recordingSession().session,
        }).pipe(
          Effect.provide(
            mockComputeLayer({
              instance: {
                update: (req: unknown) => {
                  requests.push(req)
                  return Effect.succeed(updated)
                },
              },
            }),
          ),
        ),
      )

      expect(result).toBe(updated)
      const request = requests[0] as {
        metadata: { parentId: string; resourceVersion: string; labels: Record<string, string> }
        spec: unknown
      }
      // The compute API requires `metadata.parentId` on an update (unlike VPC resources):
      // omitting it answers `INVALID_ARGUMENT: ParentID is invalid`.
      expect(request.metadata.parentId).toBe('project-9')
      expect(request.metadata.resourceVersion).toBe('0')
      expect(request.metadata.labels).toEqual({ 'alchemy::id': 'test-id' })
    })

    test('a LABELS-ONLY change still updates, and carries the full merged map', async () => {
      const requests: Array<unknown> = []
      // The live spec IS the desired spec and the live labels are empty, so `instanceSpecDrifted` is false
      // and `labelsDrifted` is the only reason an update happens at all (AGENTS.md §Convergence). A thinner
      // live spec would drift on its own and make this test pass for the wrong reason.
      const live = protoInstance({
        metadata: { ...protoMetadata('computeinstance-abc123', 'vm-1', 'project-1'), labels: {} },
        spec: desiredFrom(),
      })

      await runEffect(
        Module.applyUpdate({
          instance: live as never,
          news: phaseProps({ labels: { team: 'platform' } }),
          olds: undefined,
          desired: desiredFrom(),
          parentId: 'project-1',
          labels: { 'alchemy::id': 'test-id', team: 'platform' },
          session: recordingSession().session,
        }).pipe(
          Effect.provide(
            mockComputeLayer({
              instance: {
                update: (req: unknown) => {
                  requests.push(req)
                  return Effect.succeed(live)
                },
              },
            }),
          ),
        ),
      )

      expect(requests).toHaveLength(1)
      expect((requests[0] as { metadata: { labels: Record<string, string> } }).metadata.labels).toEqual({
        'alchemy::id': 'test-id',
        team: 'platform',
      })
    })
  })

  describe('ensureRunning', () => {
    /**
     * A compute mock that records the **call order** and answers `instance.get` with the states the waits
     * expect. Asserting on the order is what pins the restart protocol: stop → wait STOPPED → `Start` →
     * wait RUNNING. Every state is answered as a string, which `friendlyState` passes through.
     */
    const recordingCompute = (states: ReadonlyArray<string>, live: unknown) => {
      const calls: Array<string> = []
      const requests: Array<unknown> = []
      let poll = 0
      let started: unknown
      const layer = mockComputeLayer({
        instance: {
          get: () => {
            calls.push('get')
            const state = states[Math.min(poll, states.length - 1)]
            poll += 1
            return Effect.succeed({ status: { state } })
          },
          update: (req: unknown) => {
            calls.push('update')
            requests.push(req)
            return Effect.succeed(live)
          },
          start: () => {
            calls.push('start')
            started = live
            return Effect.succeed(live)
          },
        },
      })
      return { layer, calls, requests, started: () => started }
    }

    test('an unchanged hash does not restart', async () => {
      const compute = recordingCompute(['RUNNING'], protoInstance())
      const result = await runEffect(
        Module.ensureRunning({
          instance: protoInstance() as never,
          news: phaseProps({ main: '/app/entry.ts' }),
          desiredStopped: false,
          specNews: {},
          parentId: 'project-1',
          labels: {},
          shippedHash: 'hash-a',
          previousHash: 'hash-a',
          session: recordingSession().session,
        }).pipe(Effect.provide(compute.layer)),
      )

      expect(result.restarted).toBe(false)
      expect(compute.calls).toEqual([])
    })

    test('the first deploy (no previous hash) does not restart', async () => {
      const compute = recordingCompute(['RUNNING'], protoInstance())
      const result = await runEffect(
        Module.ensureRunning({
          instance: protoInstance() as never,
          news: phaseProps({ main: '/app/entry.ts' }),
          desiredStopped: false,
          specNews: {},
          parentId: 'project-1',
          labels: {},
          shippedHash: 'hash-a',
          previousHash: undefined,
          session: recordingSession().session,
        }).pipe(Effect.provide(compute.layer)),
      )

      expect(result.restarted).toBe(false)
      expect(compute.calls).toEqual([])
    })

    test('a changed hash restarts through stop → wait STOPPED → Start → wait RUNNING', async () => {
      const session = recordingSession()
      const compute = recordingCompute(['STOPPED', 'RUNNING'], protoInstance())

      const result = await runEffect(
        Module.ensureRunning({
          instance: protoInstance() as never,
          news: phaseProps({ main: '/app/entry.ts' }),
          desiredStopped: false,
          specNews: {},
          parentId: 'project-1',
          labels: {},
          shippedHash: 'hash-b',
          previousHash: 'hash-a',
          session: session.session,
        }).pipe(Effect.provide(compute.layer)),
      )

      expect(compute.calls).toEqual(['update', 'get', 'start', 'get'])
      // The stop is transmitted as a spec write, because `stopped: false` (the start half) cannot be:
      // proto3 bool defaults encode as absent, which the API reads as "leave unchanged".
      expect((compute.requests[0] as { spec: { stopped: boolean } }).spec.stopped).toBe(true)
      expect(result.restarted).toBe(true)
      expect(session.messages().some((m) => m.includes('Restarting'))).toBe(true)
    })

    test('asking for `stopped: true` never restarts, even when the hash changed', async () => {
      const compute = recordingCompute(['STOPPED'], protoInstance())
      const result = await runEffect(
        Module.ensureRunning({
          instance: protoInstance() as never,
          news: phaseProps({ main: '/app/entry.ts', stopped: true }),
          desiredStopped: true,
          specNews: { stopped: true },
          parentId: 'project-1',
          labels: {},
          shippedHash: 'hash-b',
          previousHash: 'hash-a',
          session: recordingSession().session,
        }).pipe(Effect.provide(compute.layer)),
      )

      expect(result.restarted).toBe(false)
      expect(compute.calls).toEqual([])
    })

    test('a `stopped` prop that was removed starts a stopped VM', async () => {
      const session = recordingSession()
      const compute = recordingCompute(['RUNNING'], protoInstance({ spec: { stopped: true } }))

      const result = await runEffect(
        Module.ensureRunning({
          instance: protoInstance({ spec: { stopped: true } }) as never,
          news: phaseProps(),
          desiredStopped: false,
          specNews: {},
          parentId: 'project-1',
          labels: {},
          shippedHash: undefined,
          previousHash: undefined,
          session: session.session,
        }).pipe(Effect.provide(compute.layer)),
      )

      expect(compute.calls).toEqual(['start', 'get'])
      // Not a restart: the witness drives the caller's read-back, and nothing about the code changed.
      expect(result.restarted).toBe(false)
      expect(session.messages().some((m) => m.includes('no longer set'))).toBe(true)
    })

    test('a low-level instance (no `main`) is never restarted or started', async () => {
      const compute = recordingCompute(['STOPPED'], protoInstance({ spec: { stopped: true } }))
      const result = await runEffect(
        Module.ensureRunning({
          instance: protoInstance({ spec: { stopped: true } }) as never,
          // No `main` and `stopped` is still true: nothing to start for.
          news: phaseProps({ stopped: true }),
          desiredStopped: true,
          specNews: { stopped: true },
          parentId: 'project-1',
          labels: {},
          shippedHash: 'hash-b',
          previousHash: 'hash-a',
          session: recordingSession().session,
        }).pipe(Effect.provide(compute.layer)),
      )

      expect(result.restarted).toBe(false)
      expect(compute.calls).toEqual([])
    })
  })
})

/** Run the provider diff with a custom persisted `output` (default: none). */
// oxlint-disable-next-line no-explicit-any — test helper bridging Effect.fn's any-captured context
const runDiffWithOutput = async (
  provider: { diff?: (input: any) => Effect.Effect<any, any, any> },
  news: unknown,
  olds: unknown,
  output: unknown,
  // extra layer providers for code-hash diff (FileSystem/Path)
  ...providers: Array<(effect: Effect.Effect<any, any, any>) => Effect.Effect<any, any, any>>
): Promise<unknown> => {
  if (!provider.diff) throw new Error('provider has no diff lifecycle')
  let effect: Effect.Effect<any, any, any> = provider.diff({
    id: 'test-id',
    fqn: 'test',
    instanceId: 'inst',
    olds,
    news,
    oldBindings: [],
    newBindings: [],
    output,
  })
  for (const provide of providers) effect = provide(effect)
  return runEffect(effect)
}

/** Minimal valid Instance props (all required sub-schemas populated). */
const validInstanceProps = {
  // Realistic IDs on purpose: the brands carry `isResourceId` refinements
  // (`serviceaccount-`), so a placeholder like `sa-abc123` fails validation.
  serviceAccountId: IamIds.ServiceAccountId.make('serviceaccount-abc123'),
  resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
  bootDisk: {
    attachMode: 'READ_WRITE',
    managedDisk: {
      name: 'boot-disk',
      spec: {
        type: 'NETWORK_SSD',
        sizeGibibytes: 64,
        sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
      },
    },
  },
  networkInterfaces: [
    {
      subnetId: VpcIds.SubnetId.make('subnet-abc123'),
      name: 'eth0',
      ipAddress: { allocationId: '' },
    },
  ],
}

describe('Nebius.compute.v1.Instance', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusInstance).toBeDefined()
    expect(typeof Module.NebiusInstance).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusInstanceProvider).toBeDefined()
  })

  describe('diff', () => {

    // ── create-only spec fields (gpuCluster is settable only at creation, so a
    //    change must REPLACE rather than update; before this it planned as
    //    "no changes") + replace ordering (Factory.replaceKeepingName) ────────

    // A *generated* name is minted fresh per generation, so the replacement can
    // be created before the old one is deleted. A *pinned* name is reused, so
    // the create would hit ALREADY_EXISTS and this provider's create-recovery
    // would adopt the OLD instance for GC to delete.
    const createFirst = { action: 'replace' }
    const deleteFirst = { action: 'replace', deleteFirst: true }

    test('GPU cluster change replaces; a generated name stays create-first', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps, gpuCluster: { id: 'gpucluster-new' } },
          { ...validInstanceProps, gpuCluster: { id: 'gpucluster-old' } },
        ),
      ).toEqual(createFirst)
    })

    test('GPU cluster change with a pinned name is delete-first', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps, name: 'trainer', gpuCluster: { id: 'gpucluster-new' } },
          { ...validInstanceProps, name: 'trainer', gpuCluster: { id: 'gpucluster-old' } },
        ),
      ).toEqual(deleteFirst)
    })

    test('host-mode toggle with a pinned name is delete-first', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      // Same hazard class as gpuCluster: the toggle replaces while keeping the name.
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps, name: 'trainer', main: '/app/entry.ts' },
          { ...validInstanceProps, name: 'trainer' },
        ),
      ).toEqual(deleteFirst)
    })

    test('a name change is create-first even when gpuCluster also changed', async () => {
      // The replacement has a different physical name, so the two can coexist —
      // the name rule dominates and avoids an unnecessary outage.
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps, name: 'new-name', gpuCluster: { id: 'gpucluster-new' } },
          { ...validInstanceProps, name: 'old-name', gpuCluster: { id: 'gpucluster-old' } },
        ),
      ).toEqual(createFirst)
    })

    test('adding or removing a GPU cluster on an existing instance requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      // Added: the instance is already running without a cluster.
      expect(
        await runDiff(svc, { ...validInstanceProps, gpuCluster: { id: 'gpucluster-new' } }, { ...validInstanceProps }),
      ).toEqual(createFirst)
      // Removed: the instance is attached to a cluster it cannot leave in place.
      expect(
        await runDiff(svc, { ...validInstanceProps }, { ...validInstanceProps, gpuCluster: { id: 'gpucluster-old' } }),
      ).toEqual(createFirst)
    })

    test('an unchanged GPU cluster is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const cluster = { gpuCluster: { id: 'gpucluster-same' } }
      expect(await runDiff(svc, { ...validInstanceProps, ...cluster }, { ...validInstanceProps, ...cluster })).toBeUndefined()
    })

    test('a GPU cluster change outranks an in-place spec change (replace, not update)', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(
          svc,
          {
            ...validInstanceProps,
            gpuCluster: { id: 'gpucluster-new' },
            filesystems: [
              { attachMode: 'READ_WRITE' as const, mountTag: 'data', existingFilesystem: { id: 'filesystem-abc123' } },
            ],
          },
          { ...validInstanceProps, gpuCluster: { id: 'gpucluster-old' } },
        ),
      ).toEqual(createFirst)
    })

    test('a preemptible toggle requires a replace (the API cannot convert either way)', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      // Proto: "A preemptible VM cannot be converted to a regular VM or vice versa."
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps, preemptible: { onPreemption: 'STOP' } },
          { ...validInstanceProps },
        ),
      ).toEqual({ action: 'replace' })
      // ...and removing it back is the same transition.
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps },
          { ...validInstanceProps, preemptible: { onPreemption: 'STOP' } },
        ),
      ).toEqual({ action: 'replace' })
    })

    test('a preemptible change with a pinned name is delete-first', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps, name: 'trainer', preemptible: { onPreemption: 'STOP' } },
          { ...validInstanceProps, name: 'trainer' },
        ),
      ).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('a parent change requires a replace (an instance cannot move projects)', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps, parentId: 'project-2' },
          { ...validInstanceProps, parentId: 'project-1' },
        ),
      ).toEqual({ action: 'replace' })
    })

    // ── host-mode diff rules (Task 4) ─────────────────────────────────────

    test('host-mode toggle ON (main added) replaces', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(svc, { ...validInstanceProps, main: '/app/entry.ts' }, { ...validInstanceProps }),
      ).toEqual({ action: 'replace' })
    })

    test('host-mode toggle OFF (main removed) is a replace', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(svc, { ...validInstanceProps }, { ...validInstanceProps, main: '/app/entry.ts' }),
      ).toEqual({ action: 'replace' })
    })

    test('hosted prop changes are in-place updates with stable attrs', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const update = { action: 'update', stables: ['id', 'parentId', 'name'] }

      expect(await runDiff(svc, { ...validInstanceProps, main: '/app/a.ts' }, { ...validInstanceProps, main: '/app/b.ts' })).toEqual(update)
      expect(await runDiff(svc, { ...validInstanceProps, handler: 'x' }, { ...validInstanceProps, handler: 'default' })).toEqual(update)
      expect(await runDiff(svc, { ...validInstanceProps, port: 4000 }, { ...validInstanceProps, port: 3000 })).toEqual(update)
      expect(await runDiff(svc, { ...validInstanceProps, env: { FOO: 'bar' } }, { ...validInstanceProps, env: {} })).toEqual(update)
      expect(await runDiff(svc, { ...validInstanceProps, build: { output: { minify: true } } }, { ...validInstanceProps, build: {} })).toEqual(update)
    })

    test('user cloud-init change is an update, not a replace (Deviation 2)', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(
          svc,
          { ...validInstanceProps, cloudInitUserData: 'echo new' },
          { ...validInstanceProps, cloudInitUserData: 'echo old' },
        ),
      ).toEqual({ action: 'update', stables: ['id', 'parentId', 'name'] })
    })

    test('a new shared filesystem plans an in-place update (Task 7b fields)', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const update = { action: 'update', stables: ['id', 'parentId', 'name'] }
      const filesystem = {
        attachMode: 'READ_WRITE' as const,
        mountTag: 'data',
        existingFilesystem: { id: 'filesystem-abc123' },
      }
      expect(await runDiff(svc, { ...validInstanceProps, filesystems: [filesystem] }, { ...validInstanceProps })).toEqual(update)
      expect(await runDiff(svc, { ...validInstanceProps, nvlInstanceGroupId: 'nvlgroup-abc123' }, { ...validInstanceProps })).toEqual(update)
    })

    test('code-only change plans an update when the bundle hash differs', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const { writeFile, rm } = await import('node:fs/promises')
      const entry = `${process.cwd()}/tests/.hosted-diff-entry.ts`
      await writeFile(entry, "import * as Effect from 'effect/Effect'\nexport default Effect.succeed({})\n")
      try {
        const news = { ...validInstanceProps, main: entry }
        const olds = { ...validInstanceProps, main: entry }
        const bundle = await runEffect(
          Hosted.bundleProgram('test-id', news as never).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(Path.layer),
          ),
        )

        // Same hash as what the VM runs → noop.
        const noop = await runDiffWithOutput(
          svc,
          news,
          olds,
          { code: { hash: bundle.hash } },
          Effect.provide(NodeFileSystem.layer),
          Effect.provide(Path.layer),
        )
        expect(noop).toBeUndefined()

        // Different hash (the VM runs an older bundle) → update.
        const update = await runDiffWithOutput(
          svc,
          news,
          olds,
          { code: { hash: 'stale-hash' } },
          Effect.provide(NodeFileSystem.layer),
          Effect.provide(Path.layer),
        )
        expect(update).toEqual({ action: 'update', stables: ['id', 'parentId', 'name'] })
      } finally {
        await rm(entry, { force: true })
      }
    })
  })

  /**
   * R-24, the apply-time half. `reconcile` is the hook that can reject a **greenfield** deploy — alchemy
   * never calls `diff` for a resource with no persisted state — so the same guard runs there, before the
   * first API call and before the hosted identity's sibling resources have anything to converge.
   *
   * No layers are provided on purpose: the assertion is on the *tag*, so a guard that had drifted later
   * (past the `ComputeGrpcService` yield, say) would surface as a service/config failure instead and this
   * test would fail rather than pass vacuously.
   */
  describe('hosted env keys are refused at apply time too (R-24)', () => {
    test('reconcile refuses an unrepresentable key before any API call', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const error = await runReconcileExpectingError(svc, { ...validInstanceProps, env: { 'A=B': 'v' } })
      expect(error._tag).toBe('InvalidHostedEnvKey')
      expect(error.keys).toEqual(['A=B'])
    })
  })

  describe('spec drift (the convergence contract)', () => {
    // The engine turns ANY props change a diff ignores into an `action: "update"`
    // (Plan.ts: `diff ?? { havePropsChanged(olds, news) ? "update" : "noop" }`), so a
    // field missing from `instanceSpecDrifted` plans an update that writes nothing.
    // This case is exported precisely so the contract is testable.
    const liveSpec = (overrides: Record<string, unknown> = {}) =>
      NebiusInstanceSchema.InstanceSpec.fromJSON({
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        serviceAccountId: 'serviceaccount-abc123',
        bootDisk: { attachMode: 'READ_WRITE', managedDisk: { spec: { type: 'NETWORK_SSD', sizeGibibytes: '64' } } },
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
        ...overrides,
      })

    const desiredFrom = (props: Record<string, unknown>) =>
      NebiusInstanceSchema.InstanceSpec.fromJSON({
        serviceAccountId: 'serviceaccount-abc123',
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        bootDisk: { attachMode: 'READ_WRITE', managedDisk: { spec: { type: 'NETWORK_SSD', sizeGibibytes: '64' } } },
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
        ...props,
      })

    test('an identical spec does not drift', () => {
      const props = { serviceAccountId: 'serviceaccount-abc123' }
      expect(Module.instanceSpecDrifted(liveSpec(), desiredFrom(props), props as never)).toBe(false)
    })

    test('a recoveryPolicy change drifts (was silently ignored)', () => {
      const live = liveSpec({ recoveryPolicy: 'RECOVER' })
      const desired = desiredFrom({ recoveryPolicy: 'FAIL' })
      expect(Module.instanceSpecDrifted(live, desired, {} as never)).toBe(true)
    })

    test('a hostname change drifts (was silently ignored)', () => {
      const live = liveSpec({ hostname: 'a' })
      const desired = desiredFrom({ hostname: 'b' })
      expect(Module.instanceSpecDrifted(live, desired, {} as never)).toBe(true)
    })

    test('the int64 boot-disk size is visible (specDeepEqual, not deepEqual)', () => {
      const live = liveSpec()
      const desired = NebiusInstanceSchema.InstanceSpec.fromJSON({
        serviceAccountId: 'serviceaccount-abc123',
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        bootDisk: { attachMode: 'READ_WRITE', managedDisk: { spec: { type: 'NETWORK_SSD', sizeGibibytes: '128' } } },
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
      })
      expect(Module.instanceSpecDrifted(live, desired, {} as never)).toBe(true)
    })

    test('an omitted optional message the server filled in is NOT a drift', () => {
      // "Guarded on the news side": no loop when the platform answers a default.
      const live = liveSpec({ localDisks: { passthroughGroup: { requested: false } } })
      expect(Module.instanceSpecDrifted(live, desiredFrom({}), {} as never)).toBe(false)
    })

    test('an omitted scalar the caller stopped pinning is NOT a drift', () => {
      // A *removal* cannot be expressed (proto3 scalars have no presence, and "absent ⇒ leave unchanged"
      // — measured for the repeated case in `spikes/instance-drift-removal-probe.ts`). Comparing the live
      // echo against the omitted prop's zero value read `'probe' !== ''` for every later reconcile: a write
      // that can never converge. The comparison is therefore on the **pin side** (`desired.<field> !== ''`).
      const live = liveSpec({ hostname: 'probe', recoveryPolicy: 'FAIL', nvlInstanceGroupId: 'nvlinstancegroup-1' })
      expect(Module.instanceSpecDrifted(live, desiredFrom({}), {} as never)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // The live echo — the platform fills in fields the props never carried
  // -------------------------------------------------------------------------
  //
  // Found live 2026-09-24 (`spikes/instance-drift-probe.ts` + `spikes/instance-drift-diagnose.ts`): an
  // unchanged `alchemy deploy` still wrote an update, because a whole-message `specDeepEqual` was comparing
  // against a spec the platform had completed. Every mocked `live` in the suite is built *from the props the
  // provider sends*, so no unit test could see it — these fixtures are the measured echo instead, and the
  // branch names come from `instanceDriftBranches`, the same function the live diagnosis calls.
  describe('the platform echo does not drift (2026-09-24)', () => {
    /**
     * What the API actually answered for a probe VM — re-runnable with `spikes/instance-drift-probe.ts`
     * (its transcript lives in the gitignored `spikes/logs/`, like every other probe log in this repo).
     */
    const liveEcho = (overrides: Record<string, unknown> = {}) =>
      NebiusInstanceSchema.InstanceSpec.fromJSON({
        serviceAccountId: 'serviceaccount-abc123',
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        bootDisk: {
          attachMode: 'READ_WRITE',
          managedDisk: {
            name: 'boot-disk',
            labels: {},
            spec: {
              type: 'NETWORK_SSD',
              sizeGibibytes: '64',
              sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
              // ← materialized empty message; the props never carried it
              diskEncryption: {},
            },
          },
        },
        secondaryDisks: [
          {
            attachMode: 'READ_WRITE',
            managedDisk: {
              name: 'data-disk',
              labels: {},
              spec: { type: 'NETWORK_SSD', sizeGibibytes: '128', diskEncryption: {} },
            },
          },
        ],
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: {} }],
        // ← the API materializes this one even when the props omitted it
        reservationPolicy: {},
        gpuCluster: {},
        // ← facts about the VM that no prop asked for
        hostname: 'platform-derived',
        cloudInitUserData: '#cloud-config\n',
        ...overrides,
      })

    /** The same props the provider would send: nothing but what the caller pinned. */
    const pinnedDesired = () =>
      NebiusInstanceSchema.InstanceSpec.fromJSON({
        serviceAccountId: 'serviceaccount-abc123',
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        bootDisk: {
          attachMode: 'READ_WRITE',
          managedDisk: {
            name: 'boot-disk',
            spec: {
              type: 'NETWORK_SSD',
              sizeGibibytes: '64',
              sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
            },
          },
        },
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
      })

    /** `toJSON` is `unknown`; this is the API's own rendering, used to build a *diffed* pair of specs. */
    const specJson = (spec: NebiusInstanceSchema.InstanceSpec): Record<string, unknown> =>
      NebiusInstanceSchema.InstanceSpec.toJSON(spec) as Record<string, unknown>

    /** Just the branch **names** that fire — the assertion shape a diagnosis reads. */    const firingBranches = (
      live: NebiusInstanceSchema.Instance['spec'],
      desired: NebiusInstanceSchema.InstanceSpec,
    ): string[] =>
      Module.instanceDriftBranches(live, desired, {} as never)
        .filter(([, drifted]) => drifted)
        .map(([name]) => name)

    test('the measured echo fires no branch at all', () => {
      expect(firingBranches(liveEcho(), pinnedDesired())).toEqual([])
    })

    test('a materialized empty message inside a repeated field is NOT a drift', () => {
      // The data disk's `diskEncryption: {}` — the second branch the live diagnosis caught — and, with it,
      // an interaction the old whole-array comparison could not express: `pinnedListDrifted` pins the
      // element count, so a live list that is *longer* than the props' is still compared element-wise.
      const withPinnedDisk = NebiusInstanceSchema.InstanceSpec.fromJSON({
        ...specJson(pinnedDesired()),
        secondaryDisks: [
          { attachMode: 'READ_WRITE', managedDisk: { name: 'data-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: '128' } } },
        ],
      })
      expect(Module.instanceSpecDrifted(liveEcho(), withPinnedDisk, {} as never)).toBe(false)
    })

    test('a live data disk the props omit is NOT a drift — nothing to write', () => {
      // Measured: an update whose spec omits `secondaryDisks` leaves the disk attached
      // (`spikes/instance-drift-removal-probe.ts`, `resourceVersion` 3 → 4 with both disks still there), so
      // an empty desired list pins nothing. `protoPinnedFields([])` is `{}` — an *object*, not an array —
      // which is why the empty case is handled before the pinned comparison rather than inside it.
      expect(Module.instanceSpecDrifted(liveEcho(), pinnedDesired(), {} as never)).toBe(false)
    })

    test('the echo is still visible where it matters: a pinned value that differs DRIFTS', () => {
      const withPinnedDisk = NebiusInstanceSchema.InstanceSpec.fromJSON({
        ...specJson(pinnedDesired()),
        secondaryDisks: [
          { attachMode: 'READ_WRITE', managedDisk: { name: 'data-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: '256' } } },
        ],
      })
      // The pinned 256 GiB against the live 128 — the int64 is visible through the pinning comparison
      // (`specDeepEqual` at the leaves), which is the whole point of not using `deepEqual`.
      expect(firingBranches(liveEcho(), withPinnedDisk)).toEqual(['secondaryDisks'])
    })

    test('a pinned hostname that changed still DRIFTS (the positive control)', () => {
      // Without this the suite would pass for a provider that simply stopped comparing `hostname`.
      const wanted = NebiusInstanceSchema.InstanceSpec.fromJSON({
        ...specJson(pinnedDesired()),
        hostname: 'wanted',
      })
      expect(firingBranches(liveEcho(), wanted)).toEqual(['hostname'])
    })
  })

  // -------------------------------------------------------------------------
  // pricing — the `pricing_model` oneof (schema pin bumped 2026-09-24)
  // -------------------------------------------------------------------------
  //
  // The proto's oneof is **flat** on `InstanceSpec` (`on_demand` / `follows_spot_price` /
  // `spot_pricing_policy{id}`), so there is no `pricing` message to mirror: the prop is a reshape, and
  // `hostedSpecInput` spreads it back. The API also couples the arm to `preemptible`
  // ("Must match the preemptible flag"), which is a plan-time error here.

  describe('stopped is a one-way switch, and pricing changes need it (2026-09-24)', () => {
    /** The live/desired pair the drift assertions use — same shape as the spec-drift describe's. */
    const liveSpec = (overrides: Record<string, unknown> = {}) =>
      NebiusInstanceSchema.InstanceSpec.fromJSON({
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        serviceAccountId: 'serviceaccount-abc123',
        bootDisk: { attachMode: 'READ_WRITE', managedDisk: { spec: { type: 'NETWORK_SSD', sizeGibibytes: '64' } } },
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
        ...overrides,
      })
    const desiredFrom = (props: Record<string, unknown>) =>
      NebiusInstanceSchema.InstanceSpec.fromJSON({
        serviceAccountId: 'serviceaccount-abc123',
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        bootDisk: { attachMode: 'READ_WRITE', managedDisk: { spec: { type: 'NETWORK_SSD', sizeGibibytes: '64' } } },
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
        ...props,
      })

    // `stopped: false` cannot be transmitted — a proto3 bool default is encoded as absent, and absent means
    // "leave unchanged" (measured live: the update was accepted, `spec.stopped` still read `true`, the VM
    // stayed STOPPED for the whole 180 s wait). So the prop is `trueOnly`, and the provider expresses
    // "start it" through the service's `Start` RPC instead.
    const invalidStopped = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validateInstanceProps({ ...validInstanceProps, ...patch }).pipe(Effect.flip))

    test('`stopped: false` is a plan-time error; `true` and omission are fine', async () => {
      expect(String(await invalidStopped({ stopped: false }))).toContain('can only be set to true')
      expect(String(await invalidStopped({ stopped: false }))).toContain('omitting it means "running"')
      await runEffect(SchemaModule.validateInstanceProps({ ...validInstanceProps, stopped: true }))
      await runEffect(SchemaModule.validateInstanceProps(validInstanceProps))
    })

    test('a stopped live VM with `stopped` omitted does NOT drift (the loop that was measured)', () => {
      // The old comparison read `live.stopped (true) !== desired.stopped (false)` and so wrote an update on
      // every reconcile that could never converge. Only `stopped: true` is comparable now; the other
      // direction is the `Start` call.
      const liveStopped = liveSpec({ stopped: true })
      expect(Module.instanceSpecDrifted(liveStopped, desiredFrom({}), {} as never)).toBe(false)
      // …and asking for stopped when it is running IS drift (the update that transmits `stopped: true`).
      expect(Module.instanceSpecDrifted(liveSpec({ stopped: false }), desiredFrom({ stopped: true }), {
        stopped: true,
      } as never)).toBe(true)
      // Asking for stopped when it already is: converged.
      expect(Module.instanceSpecDrifted(liveStopped, desiredFrom({ stopped: true }), { stopped: true } as never)).toBe(
        false,
      )
    })

    test('a pricing change without `stopped: true` fails the plan instead of the apply', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      // The coupling with `preemptible` is enforced by the props (and a breach fails first), so the arms used
      // below are both legal on a preemptible VM — leaving the stopped-instance rule as the only one in play.
      const policyId = BillingIds.PricingPolicyId.make('pricingpolicy-1')
      const pinned = { ...validInstanceProps, preemptible: { onPreemption: 'STOP' }, pricing: { followsSpotPrice: true } }
      // Both arms are legal on a preemptible VM, so this is a pricing *change* and nothing else.
      const switched = { ...pinned, pricing: { spotPricingPolicy: { id: policyId } } }

      const refusal = async (news: Record<string, unknown>, olds: Record<string, unknown>) =>
        runDiff(svc, news as never, olds as never)
          .then(() => undefined)
          .catch((caught: unknown) => String(caught))

      // Identical pricing on both sides: nothing to change, so the rule does not apply.
      expect(await refusal(pinned, pinned)).toBeUndefined()

      // Setting the arm on an instance whose props had none **is** a change (absent → set) — the very case the
      // API refused in the pricing probe — so it needs `stopped: true`, exactly like switching arms.
      expect(await refusal(pinned, validInstanceProps)).toContain('FAILED_PRECONDITION')
      expect(await refusal(switched, pinned)).toContain('FAILED_PRECONDITION')

      // …and it is accepted when the same deploy stops the VM, which is what the message tells you to do.
      expect(await refusal({ ...switched, stopped: true }, pinned)).toBeUndefined()
      expect(await refusal({ ...pinned, stopped: true }, validInstanceProps)).toBeUndefined()
    })
  })

  describe('pricing (pricing_model)', () => {
    /** The live/desired pair the drift assertions use — the same shape as the drift describe above. */
    const liveSpec = (overrides: Record<string, unknown> = {}) =>
      NebiusInstanceSchema.InstanceSpec.fromJSON({
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        serviceAccountId: 'serviceaccount-abc123',
        bootDisk: { attachMode: 'READ_WRITE', managedDisk: { spec: { type: 'NETWORK_SSD', sizeGibibytes: '64' } } },
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
        ...overrides,
      })
    const desiredFrom = (props: Record<string, unknown>) =>
      NebiusInstanceSchema.InstanceSpec.fromJSON({
        serviceAccountId: 'serviceaccount-abc123',
        resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
        bootDisk: { attachMode: 'READ_WRITE', managedDisk: { spec: { type: 'NETWORK_SSD', sizeGibibytes: '64' } } },
        networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
        ...props,
      })
    const invalidPricing = (patch: Record<string, unknown>) =>
      runEffect(
        SchemaModule.validateInstanceProps({ ...validInstanceProps, ...patch }).pipe(Effect.flip),
      )
    const validPricing = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validateInstanceProps({ ...validInstanceProps, ...patch }))
    const pricingPolicyId = BillingIds.PricingPolicyId.make('pricingpolicy-1')

    test('each arm is accepted on its matching preemptible flag', async () => {
      // The baseline is not preemptible, so `onDemand` is the arm that needs nothing else.
      await validPricing({ pricing: { onDemand: true } })
      await validPricing({ preemptible: { onPreemption: 'STOP' }, pricing: { followsSpotPrice: true } })
      await validPricing({
        preemptible: { onPreemption: 'STOP' },
        pricing: { spotPricingPolicy: { id: pricingPolicyId } },
      })
      // Omitting it stays valid either way — that is the platform's default, not a gap.
      await validPricing({})
      await validPricing({ preemptible: { onPreemption: 'STOP' } })
    })

    test('"exactly one arm" is a plan-time error, not a silent strip', async () => {
      // A `Schema.Union` of three structs would strip the surplus key (measured 2026-09-23), so the prop
      // is one struct plus a filter — the `PercentOrCount` lesson.
      expect(String(await invalidPricing({ pricing: { onDemand: true, followsSpotPrice: true } }))).toContain(
        'exactly one',
      )
      expect(String(await invalidPricing({ pricing: {} }))).toContain('exactly one')
    })

    test('the arm must match preemptible, both directions', async () => {
      expect(
        String(
          await invalidPricing({ preemptible: { onPreemption: 'STOP' }, pricing: { onDemand: true } }),
        ),
      ).toContain('Must match the preemptible flag')
      expect(String(await invalidPricing({ pricing: { followsSpotPrice: true } }))).toContain(
        'requires `preemptible`',
      )
      expect(
        String(await invalidPricing({ pricing: { spotPricingPolicy: { id: pricingPolicyId } } })),
      ).toContain('requires `preemptible`')
    })

    test('the presence switches reject `false`', async () => {
      expect(String(await invalidPricing({ pricing: { onDemand: false } }))).toContain('can only be set to true')
      expect(
        String(
          await invalidPricing({
            preemptible: { onPreemption: 'STOP' },
            pricing: { followsSpotPrice: false },
          }),
        ),
      ).toContain('can only be set to true')
    })

    test('hostedSpecInput reshapes the prop onto the flat wire fields', () => {
      // A nested `pricing` key would be dropped **silently** by `InstanceSpec.fromJSON` — the
      // `transfer.stopCondition` trap — so this is the assertion that the reshape happened at all.
      const onDemand = Module.hostedSpecInput(
        { ...validInstanceProps, pricing: { onDemand: true } } as never,
        undefined,
      )
      expect(onDemand.pricing).toBeUndefined()
      expect(onDemand.onDemand).toEqual({})
      expect(onDemand.followsSpotPrice).toBeUndefined()

      const policy = Module.hostedSpecInput(
        {
          ...validInstanceProps,
          preemptible: { onPreemption: 'STOP' },
          pricing: { spotPricingPolicy: { id: pricingPolicyId } },
        } as never,
        undefined,
      )
      expect(policy.spotPricingPolicy).toEqual({ id: 'pricingpolicy-1' })
      expect(policy.onDemand).toBeUndefined()

      // Omitted: nothing at all travels, and no `pricing` key is left behind.
      const omitted = Module.hostedSpecInput({ ...validInstanceProps } as never, undefined)
      expect(omitted.pricing).toBeUndefined()
      expect(omitted.onDemand).toBeUndefined()
      expect(omitted.followsSpotPrice).toBeUndefined()
      expect(omitted.spotPricingPolicy).toBeUndefined()
    })

    test('a pinned arm drifts; an omitted one does not, even against a materialized echo', () => {
      const props = { ...validInstanceProps, pricing: { onDemand: true } }
      const desired = desiredFrom({ onDemand: {} })
      // The live VM carries no pricing, so pinning one is a real change `reconcile` must write.
      expect(Module.instanceSpecDrifted(liveSpec(), desired, props as never)).toBe(true)

      // The anti-loop direction. The platform's materialization behaviour is **unmeasured**, so this uses
      // the shape that would loop if the comparison were unconditional: a live spec that answers the arm.
      const liveWithArm = liveSpec({ onDemand: {} })
      expect(Module.instanceSpecDrifted(liveWithArm, desired, props as never)).toBe(false)
      // …and omitting the prop compares nothing at all, whatever the live spec carries.
      const omitted = { ...validInstanceProps } as never
      const desiredOmitted = desiredFrom({})
      expect(Module.instanceSpecDrifted(liveSpec(), desiredOmitted, omitted)).toBe(false)
      expect(Module.instanceSpecDrifted(liveWithArm, desiredOmitted, omitted)).toBe(false)

      // Switching arms reads as drift: the newly pinned arm is absent from the live spec.
      const switched = { ...validInstanceProps, pricing: { followsSpotPrice: true } }
      expect(Module.instanceSpecDrifted(liveWithArm, desiredFrom({ followsSpotPrice: {} }), switched as never)).toBe(
        true,
      )
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps(validInstanceProps),
      )
      expect(result.serviceAccountId).toBe('serviceaccount-abc123')
    })

    test('rejects a GPU preset on a CPU platform', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          resources: { platform: 'cpu-d3', preset: '8gpu-128vcpu-1600gb' },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects a boot disk with neither existingDisk nor managedDisk', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          bootDisk: { attachMode: 'READ_WRITE' },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects a boot disk with neither sourceImageId nor sourceImageFamily', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          bootDisk: {
            attachMode: 'READ_WRITE',
            managedDisk: { name: 'boot-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 64 } },
          },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
      // The message has to name the hazard, not just the missing field — a blank boot
      // disk boots and serves nothing, which is a 20-minute debugging session otherwise.
      expect(result.message).toContain('Boot disk requires an OS image')
    })

    test('accepts a blank managed data disk — only the BOOT disk needs an OS image', async () => {
      // `bootDiskImageRequired` used to sit on `ManagedDiskSpecSchema`, so every managed disk
      // needed a source image: attaching a fresh data volume was rejected, and the error
      // blamed the boot disk. A data disk is legitimately blank.
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          secondaryDisks: [
            {
              attachMode: 'READ_WRITE',
              managedDisk: { name: 'data-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 128 } },
            },
          ],
        }),
      )

      expect(result.secondaryDisks?.[0]?.managedDisk?.spec?.type).toBe('NETWORK_SSD')
    })

    test('accepts a boot disk with sourceImageFamily (platform resolves the image)', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          bootDisk: {
            attachMode: 'READ_WRITE',
            managedDisk: {
              name: 'boot-disk',
              spec: { type: 'NETWORK_SSD', sizeGibibytes: 64, sourceImageFamily: { imageFamily: 'ubuntu24.04-cuda12' } },
            },
          },
        }),
      )
      expect(result.bootDisk.managedDisk?.spec?.sourceImageFamily?.imageFamily).toBe('ubuntu24.04-cuda12')
    })

    test('rejects a boot disk smaller than the 64 GiB floor (hangs provisioning)', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          bootDisk: {
            attachMode: 'READ_WRITE',
            managedDisk: {
              name: 'boot-disk',
              spec: { type: 'NETWORK_SSD', sizeGibibytes: 10, sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' } },
            },
          },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    // ── Hosted env keys (R-24) — a key systemd cannot read back fails the PLAN, not the apply ──────
    //
    // The VM reads the env file through systemd's `EnvironmentFile=`, whose parser ends a key at the first
    // `=` and an assignment at a newline. There is no quoting on the key side (unlike values: R-19), so a
    // key carrying either character silently becomes a *different* variable. Three cases: two refusals and
    // the negative control that keeps the rule from becoming an env-name charset.
    test('plan-time: an env key containing a newline is refused, and the key is named', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const error = await runDiffExpectingError(
        svc,
        { ...validInstanceProps, env: { 'KE\nY': 'v' } },
        validInstanceProps,
      )
      expect(error._tag).toBe('InvalidHostedEnvKey')
      expect(error.keys).toEqual(['KE\nY'])
      // JSON-encoded in the message, because a newline in a key is invisible in a log line otherwise.
      expect(error.message).toContain('"KE\\nY"')
    })

    test('plan-time: `=` in a key is refused — the value would absorb the rest of the line', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const error = await runDiffExpectingError(svc, { ...validInstanceProps, env: { 'A=B': 'v' } }, validInstanceProps)
      expect(error._tag).toBe('InvalidHostedEnvKey')
      expect(error.keys).toEqual(['A=B'])
    })

    test('an ordinary env change still plans as an in-place update (the guard rejects only the 3 characters)', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const result = await runDiff(
        svc,
        { ...validInstanceProps, env: { 'MY.KEY': 'a', 'MY-KEY': 'b', MY_KEY: 'c' } },
        validInstanceProps,
      )
      expect(result).toEqual({ action: 'update', stables: ['id', 'parentId', 'name'] })
    })

    test('diff fails fast at plan time on a boot disk without an image', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const result = await runEffect(
        // oxlint-disable-next-line no-explicit-any — loose cast mirrors runDiff helper
        (svc as { diff: (input: any) => Effect.Effect<any, any, any> }).diff(
          diffInput({
            ...validInstanceProps,
            bootDisk: {
              attachMode: 'READ_WRITE',
              managedDisk: { name: 'boot-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 64 } },
            },
          }),
        ).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('read fails fast at plan time for a GREENFIELD resource with a bad boot disk', async () => {
      // alchemy never calls `diff` for a resource with no persisted state
      // (Plan.ts returns early before reaching it), so `read` — invoked as the
      // greenfield adoption probe — is the ONLY plan-time hook that can catch
      // this before a first deploy. Regression guard for that path.
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      const result = await runEffect(
        // oxlint-disable-next-line no-explicit-any — loose cast mirrors runDiff helper
        (svc as { read: (input: any) => Effect.Effect<any, any, any> }).read(
          readInput({
            ...validInstanceProps,
            bootDisk: {
              attachMode: 'READ_WRITE',
              managedDisk: { name: 'boot-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 64 } },
            },
          }),
        ).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects a network interface without ipAddress (the API requires it)', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0' }],
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    // ── spec fields reachable only after Task 7b (filesystems / local disks /
    //    reservations / NVLink group) ─────────────────────────────────────
    test('accepts shared filesystems, local disks, a reservation policy and an NVLink group', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          filesystems: [
            { attachMode: 'READ_ONLY', mountTag: 'shared', existingFilesystem: { id: 'filesystem-abc123' } },
          ],
          localDisks: { passthroughGroup: { requested: true } },
          reservationPolicy: { policy: 'AUTO', reservationIds: ['reservation-abc123'] },
          nvlInstanceGroupId: 'nvlgroup-abc123',
        }),
      )
      expect(result.filesystems?.[0]?.mountTag).toBe('shared')
      expect(result.localDisks?.passthroughGroup.requested).toBe(true)
      expect(result.nvlInstanceGroupId).toBe('nvlgroup-abc123')
    })

    test('rejects a mount tag longer than 37 characters', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          filesystems: [
            {
              attachMode: 'READ_WRITE',
              mountTag: 'x'.repeat(38),
              existingFilesystem: { id: 'filesystem-abc123' },
            },
          ],
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects reservationIds combined with the FORBID policy', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          reservationPolicy: { policy: 'FORBID', reservationIds: ['reservation-abc123'] },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('serialises the new spec fields onto the wire through InstanceSpec.fromJSON', () => {
      // Guards the AGENTS.md rule: enum-bearing specs must go through `fromJSON`
      // (nested-message aware, string → int32), never `fromPartial`.
      const spec = NebiusInstanceSchema.InstanceSpec.fromJSON({
        filesystems: [
          { attachMode: 'READ_WRITE', mountTag: 'shared', existingFilesystem: { id: 'filesystem-abc123' } },
        ],
        localDisks: { passthroughGroup: { requested: true } },
        reservationPolicy: { policy: 'STRICT', reservationIds: ['reservation-abc123'] },
        nvlInstanceGroupId: 'nvlgroup-abc123',
        gpuCluster: { id: 'gpucluster-abc123' },
      })
      expect(spec.filesystems[0]?.attachMode).toBe(
        NebiusInstanceSchema.AttachedFilesystemSpec_AttachMode.READ_WRITE,
      )
      expect(spec.filesystems[0]?.existingFilesystem?.id).toBe('filesystem-abc123')
      expect(spec.localDisks?.passthroughGroup?.requested).toBe(true)
      expect(spec.reservationPolicy?.policy).toBe(NebiusInstanceSchema.ReservationPolicy_Policy.STRICT)
      expect(spec.reservationPolicy?.reservationIds).toEqual(['reservation-abc123'])
      expect(spec.nvlInstanceGroupId).toBe('nvlgroup-abc123')
      // Nested message: `fromJSON` is what builds `InstanceGpuClusterSpec`.
      expect(spec.gpuCluster?.id).toBe('gpucluster-abc123')
    })
  })

  describe('spec stripping (hosted props never reach InstanceSpec.fromJSON)', () => {
    test('hosted props are removed and the merged user-data is injected', async () => {
      const spec = Module.hostedSpecInput(
        {
          ...validInstanceProps,
          main: '/app/entry.ts',
          handler: 'default',
          port: 8080,
          env: { FOO: 'bar' },
          build: { output: { minify: true } },
          isExternal: false,
          bucket: 'shared-bucket',
          hosted: { bucketName: 'x' },
          cloudInitUserData: 'echo user',
        } as SchemaModule.InstanceProps,
        '# generated bootstrap\necho user',
      )
      for (const key of ['main', 'handler', 'port', 'env', 'build', 'isExternal', 'bucket', 'hosted']) {
        expect(key in spec).toBe(false)
      }
      // The merged bootstrap (generated first, user's after) is what the API stores.
      expect(spec.cloudInitUserData).toBe('# generated bootstrap\necho user')
      // The spec input keeps the low-level fields — including the create-only
      // `gpuCluster`, which is a real InstanceSpec field, not a hosted prop.
      expect(spec.serviceAccountId).toBe('serviceaccount-abc123')
      expect(spec.resources).toBeDefined()
    })

    test('`gpuCluster` is a low-level spec field, not a hosted prop', async () => {
      const spec = Module.hostedSpecInput(
        { ...validInstanceProps, gpuCluster: { id: GpuClusterId.make('gpucluster-abc123') } } as SchemaModule.InstanceProps,
        undefined,
      )
      expect(spec.gpuCluster).toEqual({ id: 'gpucluster-abc123' })
      expect(NebiusInstanceSchema.InstanceSpec.fromJSON(spec).gpuCluster?.id).toBe('gpucluster-abc123')
    })

    test('low-level mode keeps the user cloud-init untouched', async () => {
      const spec = Module.hostedSpecInput(
        { ...validInstanceProps, cloudInitUserData: 'echo user' } as SchemaModule.InstanceProps,
        undefined,
      )
      expect(spec.cloudInitUserData).toBe('echo user')
      expect('main' in spec).toBe(false)
    })
  })
})
