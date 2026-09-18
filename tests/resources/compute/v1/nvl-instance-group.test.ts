import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import * as Module from '../../../../modules/resources/compute/v1/nvl-instance-group.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/nvl-instance-group.schema.ts'
import * as ComputeSchema from '../../../../schemas/nebius/compute/v1/nvlinstancegroup.ts'
import {
  fakeSession,
  instanceIdLayer,
  mockComputeLayer,
  notFoundError,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from '../../../helpers/mocks.ts'
import {
  resolveProvider,
  runDelete,
  runDeleteExpectingError,
  runDiff,
  runEffect,
  runReconcile,
} from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

const validProps = { type: 'GB200' as const, size: 2 }

const groupProto = (overrides: Partial<ComputeSchema.NVLInstanceGroup> = {}): ComputeSchema.NVLInstanceGroup => ({
  metadata: protoMetadata('nvlgroup-1', 'my-nvl-group', 'project-test-1'),
  // Real generated constructors: a hand-rolled stand-in is not
  // `deepEqual` to a real Long, which would make reconcile update every time.
  spec: ComputeSchema.NVLInstanceGroupSpec.fromJSON({ type: 'GB200', size: '2' }),
  status: { instances: {}, reconciling: false },
  ...overrides,
})

describe('Nebius.compute.v1.NVLInstanceGroup', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusNVLInstanceGroup).toBeDefined()
    expect(typeof Module.NebiusNVLInstanceGroup).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusNVLInstanceGroupProvider).toBeDefined()
  })

  describe('diff', () => {
    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      expect(await runDiff(svc, validProps, validProps)).toBeUndefined()
    })

    test('a size change is an in-place update, not a replace', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      expect(await runDiff(svc, { ...validProps, size: 4 }, validProps)).toBeUndefined()
    })

    test('a type change replaces; a generated name stays create-first', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      expect(await runDiff(svc, { ...validProps, type: 'GB300' }, validProps)).toEqual({ action: 'replace' })
    })

    test('a type change with a pinned name is delete-first', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      expect(
        await runDiff(
          svc,
          { ...validProps, name: 'rack-a', type: 'GB300' },
          { ...validProps, name: 'rack-a', type: 'GB200' },
        ),
      ).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('a name change is create-first', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      expect(await runDiff(svc, { ...validProps, name: 'new' }, { ...validProps, name: 'old' })).toEqual({
        action: 'replace',
      })
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SchemaModule.validateNVLInstanceGroupProps(validProps))
      expect(result.type).toBe('GB200')
      expect(result.size).toBe(2)
    })

    test('rejects a non-positive or fractional size', async () => {
      for (const size of [0, -1, 1.5]) {
        const result = await runEffect(
          SchemaModule.validateNVLInstanceGroupProps({ ...validProps, size }).pipe(Effect.flip),
        )
        expect(result._tag).toBe('PropsValidationError')
        expect(String(result.message)).toContain('size must be a positive integer')
      }
    })

    test('rejects a type outside the schema enum', async () => {
      const result = await runEffect(
        SchemaModule.validateNVLInstanceGroupProps({ ...validProps, type: 'GB100' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })

  describe('reconcile', () => {
    const layerFor = (created: unknown[], updated: unknown[]) =>
      Layer.mergeAll(
        mockComputeLayer({
          nvlInstanceGroup: {
            get: () => Effect.succeed(groupProto()),
            create: (req: unknown) => {
              created.push(req)
              return Effect.succeed(groupProto())
            },
            update: (req: unknown) => {
              updated.push(req)
              return Effect.succeed(groupProto())
            },
          },
        }),
        stackLayer,
        testConfigLayer,
        instanceIdLayer,
      )

    test('creates the group, serialising the enum through fromJSON', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      const created: Array<{ spec?: ComputeSchema.NVLInstanceGroupSpec }> = []

      const attrs = await runReconcile(
        svc,
        validProps,
        undefined,
        undefined,
        Effect.provide(layerFor(created, [])),
      )

      expect(created).toHaveLength(1)
      // The enum reaches the wire as its int32, and `size` as an int64.
      expect(created[0]!.spec!.type).toBe(ComputeSchema.NVLInstanceGroupSpec_NVLInstanceGroupType.GB200)
      expect(String(created[0]!.spec!.size)).toBe('2')
      expect(attrs.id).toBe('nvlgroup-1')
    })

    test('is a noop when the live group already matches', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      const updated: unknown[] = []

      await runReconcile(svc, validProps, { id: 'nvlgroup-1' }, validProps, Effect.provide(layerFor([], updated)))

      expect(updated).toHaveLength(0)
    })

    test('a size drift is applied in place', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      const updated: Array<{ spec?: ComputeSchema.NVLInstanceGroupSpec }> = []

      await runReconcile(
        svc,
        { ...validProps, size: 8 },
        { id: 'nvlgroup-1' },
        validProps,
        Effect.provide(layerFor([], updated)),
      )

      expect(updated).toHaveLength(1)
      expect(String(updated[0]!.spec!.size)).toBe('8')
    })
  })

  describe('delete (member guard)', () => {
    const deleteInput = {
      id: 'Rack',
      fqn: 'Rack',
      instanceId: 'inst',
      olds: validProps,
      output: { id: 'nvlgroup-1' },
      session: fakeSession,
      bindings: [],
    }

    test('refuses to delete a group that still has instances, naming them', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      let deleted = false
      const layer = mockComputeLayer({
        nvlInstanceGroup: {
          get: () =>
            Effect.succeed(
              groupProto({
                metadata: protoMetadata('nvlgroup-1', 'rack-a', 'project-test-1'),
                status: {
                  instances: {
                    'computeinstance-e00abc': { instanceState: 3 },
                    'computeinstance-e00def': { instanceState: 3 },
                  },
                  reconciling: false,
                },
              }),
            ),
          delete: () => {
            deleted = true
            return Effect.void
          },
        },
      })

      const error = await runDeleteExpectingError(svc, deleteInput.output, deleteInput.olds, Effect.provide(layer))

      expect(deleted).toBe(false)
      expect(error._tag).toBe('NVLInstanceGroupNotEmpty')
      expect(error.instances.sort()).toEqual(['computeinstance-e00abc', 'computeinstance-e00def'])
      // The message points at the in-place escape hatch, which GPU clusters lack.
      expect(error.message).toContain('nvlInstanceGroupId` can also be changed in place')
    })

    test('deletes an empty group', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      const deletedIds: string[] = []
      const layer = mockComputeLayer({
        nvlInstanceGroup: {
          get: () => Effect.succeed(groupProto()),
          delete: (id: string) => {
            deletedIds.push(id)
            return Effect.void
          },
        },
      })

      await runDelete(svc, deleteInput.output, deleteInput.olds, Effect.provide(layer))
      expect(deletedIds).toEqual(['nvlgroup-1'])
    })

    test('is idempotent when the group is already gone', async () => {
      const svc = await resolveProvider(Module.NebiusNVLInstanceGroup.Provider, Module.NebiusNVLInstanceGroupProvider)
      let deleted = false
      const layer = mockComputeLayer({
        nvlInstanceGroup: {
          get: () => Effect.fail(notFoundError()),
          delete: () => {
            deleted = true
            return Effect.void
          },
        },
      })

      await runDelete(svc, deleteInput.output, deleteInput.olds, Effect.provide(layer))
      expect(deleted).toBe(false)
    })
  })
})
