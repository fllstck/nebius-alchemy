import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as DiskModule from '../../../../modules/resources/compute/v1/disk.ts'
import * as DiskSchema from '../../../../modules/resources/compute/v1/disk.schema.ts'
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
      expect(await runDiff(svc, { name: 'new-disk' }, { name: 'old-disk' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(DiskModule.NebiusDisk.Provider, DiskModule.NebiusDiskProvider)
      expect(await runDiff(svc, { name: 'my-disk', sizeGibibytes: 10 }, { name: 'my-disk', sizeGibibytes: 10 })).toBeUndefined()
    })

    test('size-only change is NOT a replace (in-place update)', async () => {
      const svc = await resolveProvider(DiskModule.NebiusDisk.Provider, DiskModule.NebiusDiskProvider)
      expect(await runDiff(svc, { name: 'my-disk', sizeGibibytes: 20 }, { name: 'my-disk', sizeGibibytes: 10 })).toBeUndefined()
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
  })
})
