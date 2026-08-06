import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/compute/v1/filesystem.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/filesystem.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

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
      expect(await runDiff(svc, { type: 'WEKA' }, { type: 'NETWORK_SSD' })).toEqual({ action: 'replace' })
    })

    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusFilesystem.Provider, Module.NebiusFilesystemProvider)
      expect(await runDiff(svc, { name: 'new-fs' }, { name: 'old-fs' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusFilesystem.Provider, Module.NebiusFilesystemProvider)
      expect(await runDiff(svc, { type: 'WEKA' }, { type: 'WEKA' })).toBeUndefined()
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
})
