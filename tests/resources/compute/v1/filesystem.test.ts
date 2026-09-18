import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import Long from 'long'
import * as Module from '../../../../modules/resources/compute/v1/filesystem.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/filesystem.schema.ts'
import * as ComputeSchema from '../../../../schemas/nebius/compute/v1/filesystem.ts'
import {
  instanceIdLayer,
  mockComputeLayer,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from '../../../helpers/mocks.ts'
import { resolveProvider, runDiff, runEffect, runReconcile } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.Filesystem', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusFilesystem).toBeDefined()
    expect(typeof Module.NebiusFilesystem).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusFilesystemProvider).toBeDefined()
  })

  describe('diff', () => {
    test('type change requires replace (immutable)', async () => {
      const svc = await resolveProvider(Module.NebiusFilesystem.Provider, Module.NebiusFilesystemProvider)
      expect(await runDiff(svc, { type: 'WEKA', sizeGibibytes: 1024 }, { type: 'NETWORK_SSD', sizeGibibytes: 1024 })).toEqual({ action: 'replace' })
    })

    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusFilesystem.Provider, Module.NebiusFilesystemProvider)
      expect(await runDiff(svc, { type: 'WEKA', name: 'new-fs', sizeGibibytes: 1024 }, { type: 'WEKA', name: 'old-fs', sizeGibibytes: 1024 })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusFilesystem.Provider, Module.NebiusFilesystemProvider)
      expect(await runDiff(svc, { type: 'WEKA', sizeGibibytes: 1024 }, { type: 'WEKA', sizeGibibytes: 1024 })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateFilesystemProps({ type: 'WEKA', sizeGibibytes: 1024 }),
      )
      expect(result.type).toBe('WEKA')
    })

    test('rejects invalid block size (not a power of two)', async () => {
      const result = await runEffect(
        SchemaModule.validateFilesystemProps({ type: 'WEKA', sizeGibibytes: 1024, blockSizeBytes: 3000 }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })

  describe('reconcile', () => {
    const fsProto = (gibibytes: number): ComputeSchema.Filesystem => ({
      metadata: protoMetadata('filesystem-1', 'my-fs', 'project-test-1'),
      spec: ComputeSchema.FilesystemSpec.fromJSON({ type: 'NETWORK_SSD', sizeGibibytes: String(gibibytes) }),
      status: {
        state: ComputeSchema.FilesystemStatus_State.READY,
        // `FilesystemStatus.toJSON` calls `.equals` on the int64 fields without
        // an undefined guard (generated code), so the fixture must carry them —
        // as a live response does.
        sizeBytes: Long.fromNumber(gibibytes * 1024 ** 3),
        blockSizeBytes: Long.fromNumber(4096),
        reconciling: false,
        stateDescription: '',
        readWriteAttachments: [],
        readOnlyAttachments: [],
      },
    })

    const layerFor = (live: ComputeSchema.Filesystem, updated: Array<{ spec?: ComputeSchema.FilesystemSpec }>) =>
      Effect.provide(
        Layer.mergeAll(
          mockComputeLayer({
            filesystem: {
              get: () => Effect.succeed(live),
              update: (req: { spec?: ComputeSchema.FilesystemSpec }) => {
                updated.push(req)
                return Effect.succeed(live)
              },
            },
          }),
          stackLayer,
          testConfigLayer,
          instanceIdLayer,
        ),
      )

    test('a size change is applied — the int64 is visible (regression: deepEqual blinded it)', async () => {
      const svc = await resolveProvider(Module.NebiusFilesystem.Provider, Module.NebiusFilesystemProvider)
      const updated: Array<{ spec?: ComputeSchema.FilesystemSpec }> = []

      await runReconcile(
        svc,
        { type: 'NETWORK_SSD', sizeGibibytes: 128 },
        { id: 'filesystem-1' },
        undefined,
        layerFor(fsProto(64), updated),
      )

      expect(updated).toHaveLength(1)
      expect(String(updated[0]!.spec!.sizeGibibytes)).toBe('128')
    })

    test('an unchanged size is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusFilesystem.Provider, Module.NebiusFilesystemProvider)
      const updated: Array<{ spec?: ComputeSchema.FilesystemSpec }> = []

      await runReconcile(
        svc,
        { type: 'NETWORK_SSD', sizeGibibytes: 64 },
        { id: 'filesystem-1' },
        undefined,
        layerFor(fsProto(64), updated),
      )

      expect(updated).toHaveLength(0)
    })
  })
})
