import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as DiskModule from '../../../../modules/resources/compute/v1/disk.ts'
import * as DiskSchema from '../../../../modules/resources/compute/v1/disk.schema.ts'
import * as NebiusDiskSchema from '../../../../schemas/nebius/compute/v1/disk.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.Disk', () => {
  test('NebiusDisk resource constructor is defined', () => {
    expect(DiskModule.NebiusDisk).toBeDefined()
    expect(typeof DiskModule.NebiusDisk).toBe('function')
  })

  test('NebiusDiskProvider is defined', () => {
    expect(DiskModule.NebiusDiskProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(DiskModule.NebiusDisk.Provider, DiskModule.NebiusDiskProvider)
      expect(await runDiff(svc, { name: 'new-disk', sizeGibibytes: 10, type: 'NETWORK_SSD' }, { name: 'old-disk', sizeGibibytes: 10, type: 'NETWORK_SSD' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(DiskModule.NebiusDisk.Provider, DiskModule.NebiusDiskProvider)
      expect(await runDiff(svc, { name: 'my-disk', sizeGibibytes: 10, type: 'NETWORK_SSD' }, { name: 'my-disk', sizeGibibytes: 10, type: 'NETWORK_SSD' })).toBeUndefined()
    })

    test('size-only change is NOT a replace (in-place update)', async () => {
      const svc = await resolveProvider(DiskModule.NebiusDisk.Provider, DiskModule.NebiusDiskProvider)
      expect(await runDiff(svc, { name: 'my-disk', sizeGibibytes: 20, type: 'NETWORK_SSD' }, { name: 'my-disk', sizeGibibytes: 10, type: 'NETWORK_SSD' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        DiskSchema.validateDiskProps({ type: 'NETWORK_SSD', sizeGibibytes: 10 }),
      )
      expect(result.type).toBe('NETWORK_SSD')
    })

    test('rejects unknown disk type', async () => {
      const result = await runEffect(
        DiskSchema.validateDiskProps({ type: 'NOT_A_TYPE' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(
        DiskSchema.validateDiskProps({ type: 'NETWORK_SSD', name: 'Bad Name!' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    // ── create sources + encryption (Task 7b schema-audit gaps) ──────────
    // These fields existed in the generated `DiskSpec` but were absent from the
    // module props schema, so a disk could not be created from a snapshot or
    // encrypted at all.
    test('accepts a snapshot source', async () => {
      const result = await runEffect(
        DiskSchema.validateDiskProps({
          type: 'NETWORK_SSD',
          sizeGibibytes: 10,
          sourceSnapshotId: 'disksnapshot-abc123',
        }),
      )
      expect(result.sourceSnapshotId).toBe('disksnapshot-abc123')
    })

    test('accepts an encryption config', async () => {
      const result = await runEffect(
        DiskSchema.validateDiskProps({
          type: 'NETWORK_SSD',
          sizeGibibytes: 10,
          diskEncryption: { type: 'DISK_ENCRYPTION_MANAGED' },
        }),
      )
      expect(result.diskEncryption?.type).toBe('DISK_ENCRYPTION_MANAGED')
    })

    test('rejects an image source combined with a snapshot source', async () => {
      // The API rejects combinations; fail at plan time instead.
      const result = await runEffect(
        DiskSchema.validateDiskProps({
          type: 'NETWORK_SSD',
          sizeGibibytes: 10,
          sourceImageId: 'image-abc123',
          sourceSnapshotId: 'disksnapshot-abc123',
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('serialises the encryption enum to its protobuf int32', () => {
      // Guards the AGENTS.md rule: specs with enum fields must go through
      // `fromJSON` (which recurses into nested messages), not `fromPartial`
      // (which would pass the string through and encode NaN).
      const spec = NebiusDiskSchema.DiskSpec.fromJSON({
        type: 'NETWORK_SSD',
        sizeGibibytes: 10,
        sourceSnapshotId: 'disksnapshot-abc123',
        diskEncryption: { type: 'DISK_ENCRYPTION_MANAGED' },
      })
      expect(spec.diskEncryption?.type).toBe(NebiusDiskSchema.DiskEncryption_DiskEncryptionType.DISK_ENCRYPTION_MANAGED)
      expect(spec.sourceSnapshotId).toBe('disksnapshot-abc123')
    })
  })
})
