import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/compute/v1/disk-snapshot.ts'
import * as ResourceUtils from '../../../../modules/resources/utilities.ts'
import * as ComputeSchema from '../../../../schemas/nebius/compute/v1/disk_snapshot.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/disk-snapshot.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.DiskSnapshot', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusDiskSnapshot).toBeDefined()
    expect(typeof Module.NebiusDiskSnapshot).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusDiskSnapshotProvider).toBeDefined()
  })

  describe('diff', () => {
    test('sourceDiskId change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusDiskSnapshot.Provider, Module.NebiusDiskSnapshotProvider)
      expect(await runDiff(svc, { sourceDiskId: 'disk-2' }, { sourceDiskId: 'disk-1' })).toEqual({ action: 'replace' })
    })

    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusDiskSnapshot.Provider, Module.NebiusDiskSnapshotProvider)
      expect(await runDiff(svc, { name: 'new-snap', sourceDiskId: 'disk-1' }, { name: 'old-snap', sourceDiskId: 'disk-1' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusDiskSnapshot.Provider, Module.NebiusDiskSnapshotProvider)
      expect(await runDiff(svc, { sourceDiskId: 'disk-1' }, { sourceDiskId: 'disk-1' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateDiskSnapshotProps({ sourceDiskId: 'disk-abc123' as SchemaModule.DiskSnapshotProps['sourceDiskId'] }),
      )
      expect(result.sourceDiskId).toBe('disk-abc123')
    })

    test('rejects props without the required sourceDiskId', async () => {
      const result = await runEffect(
        SchemaModule.validateDiskSnapshotProps({}).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('attributes: int64 fields arrive as decimal strings', () => {
  /**
   * `toFriendlyAttributes` merges `spec.toJSON`/`status.toJSON`, and ts-proto renders every int64 as a
   * decimal **string** — so an attribute typed `Schema.Finite` was a type that lied, and a consumer
   * doing arithmetic on it silently concatenated. The schemas now say `Schema.String` (like
   * `RecordAttributes.ttl`); this pins the runtime side of that contract, so "fixing" the types back
   * to numbers cannot land without a decision.
   */
  test('DiskSnapshot reports its int64 attributes as strings', () => {
    // The same call the provider makes — `toFriendlyAttributes` is not re-exported by every module,
    // and the behaviour under test lives in the shared helper anyway.
    const attrs = ResourceUtils.toFriendlyAttributes<Record<string, unknown>>({
      rawResource: ComputeSchema.DiskSnapshot.fromJSON({
        spec: {},
        status: { contentSizeBytes: '1024', storageSizeBytes: '2048' },
        metadata: { id: 'computedisksnapshot-1', name: 'snap', parentId: 'project-1' },
      }),
      resourceSchema: ComputeSchema.DiskSnapshot,
    })
    expect(attrs.contentSizeBytes).toBe('1024')
    expect(attrs.storageSizeBytes).toBe('2048')
  })
})
