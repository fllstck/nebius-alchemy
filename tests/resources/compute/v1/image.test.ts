import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/compute/v1/image.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/image.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.Image', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusImage).toBeDefined()
    expect(typeof Module.NebiusImage).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusImageProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusImage.Provider, Module.NebiusImageProvider)
      expect(await runDiff(svc, { name: 'new-image', sourceDiskId: 'disk-abc123' }, { name: 'old-image', sourceDiskId: 'disk-abc123' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusImage.Provider, Module.NebiusImageProvider)
      expect(await runDiff(svc, { name: 'my-image', description: 'x', sourceDiskId: 'disk-abc123' }, { name: 'my-image', description: 'x', sourceDiskId: 'disk-abc123' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({ name: 'my-image', description: 'a golden image', sourceDiskId: 'disk-abc123' }),
      )
      expect(result.name).toBe('my-image')
    })

    test('rejects props without a source disk or snapshot', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({ name: 'my-image' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({ name: 'My Image!' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
