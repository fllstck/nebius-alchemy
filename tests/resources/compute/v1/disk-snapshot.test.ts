import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/compute/v1/disk-snapshot'
import * as SchemaModule from '../../../../modules/resources/compute/v1/disk-snapshot.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'

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
