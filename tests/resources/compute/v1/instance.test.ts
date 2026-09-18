import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Path from 'effect/Path'
import { NodeFileSystem } from '@effect/platform-node'
import * as Module from '../../../../modules/resources/compute/v1/instance.ts'
import * as Hosted from '../../../../modules/resources/compute/v1/hosted.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/instance.schema.ts'
import * as IamIds from '../../../../modules/resources/iam/v1/ids.ts'
import * as VpcIds from '../../../../modules/resources/vpc/v1/ids.ts'
import { GpuClusterId } from '../../../../modules/resources/compute/v1/ids.ts'
import * as NebiusInstanceSchema from '../../../../schemas/nebius/compute/v1/instance.ts'
import { readInput, resolveProvider, runDiff, runEffect, diffInput } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

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
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(
        await runDiff(svc, { ...validInstanceProps, name: 'new-instance' }, { ...validInstanceProps, name: 'old-instance' }),
      ).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(await runDiff(svc, { ...validInstanceProps, name: 'my-instance' }, { ...validInstanceProps, name: 'my-instance' })).toBeUndefined()
    })

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
