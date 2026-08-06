import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as BucketModule from '../../../../modules/resources/storage/v1/bucket.ts'
import * as NebiusBucketSchema from '../../../../schemas/nebius/storage/v1/bucket.ts'
import * as NebiusStorageBase from '../../../../schemas/nebius/storage/v1/base.ts'
import { resolveProvider, runDiff } from '../../../helpers/provider.ts'

const provider = () => resolveProvider(BucketModule.NebiusBucket.Provider, BucketModule.NebiusBucketProvider)

describe('Nebius.storage.v1.Bucket', () => {
  test('NebiusBucket resource constructor is defined', () => {
    expect(BucketModule.NebiusBucket).toBeDefined()
    expect(typeof BucketModule.NebiusBucket).toBe('function')
  })

  test('NebiusBucketProvider is defined', () => {
    expect(BucketModule.NebiusBucketProvider).toBeDefined()
  })

  describe('spec serialization', () => {
    test('fromJSON converts enum strings to int32 values (no NaN pass-through)', async () => {
      const spec = NebiusBucketSchema.BucketSpec.fromJSON({
        versioningPolicy: 'ENABLED',
        defaultStorageClass: 'STANDARD',
        objectAuditLogging: 'ALL',
        forceStorageClass: false,
      })
      // Pins the documented anti-pattern: strings must never pass through to
      // serialization (that produced NaN wire values).
      expect(spec.versioningPolicy).toBe(NebiusStorageBase.VersioningPolicy.ENABLED)
      expect(spec.defaultStorageClass).toBe(NebiusStorageBase.StorageClass.STANDARD)
      expect(spec.objectAuditLogging).toBe(NebiusBucketSchema.BucketSpec_ObjectAuditLogging.ALL)
      expect(Number.isNaN(spec.versioningPolicy)).toBe(false)
    })
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await provider()
      expect(await runDiff(svc, { name: 'new-bucket' }, { name: 'old-bucket' })).toEqual({ action: 'replace' })
    })

    test('same name is a noop (no replace)', async () => {
      const svc = await provider()
      expect(await runDiff(svc, { name: 'same-bucket' }, { name: 'same-bucket' })).toBeUndefined()
    })

    test('unresolved news short-circuits to undefined', async () => {
      const svc = await provider()
      // oxlint-disable-next-line no-explicit-any — runDiff accepts arbitrary props
      expect(await runDiff(svc, { name: Effect.succeed('x') } as any)).toBeUndefined()
    })
  })
})
