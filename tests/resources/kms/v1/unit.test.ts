import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/kms/v1/symmetric-key.ts'
import * as SchemaModule from '../../../../modules/resources/kms/v1/symmetric-key.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.kms.v1.SymmetricKey', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusSymmetricKey).toBeDefined()
    expect(typeof Module.NebiusSymmetricKey).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusSymmetricKeyProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusSymmetricKey.Provider, Module.NebiusSymmetricKeyProvider)
      expect(await runDiff(svc, { name: 'new-key' }, { name: 'old-key' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusSymmetricKey.Provider, Module.NebiusSymmetricKeyProvider)
      expect(await runDiff(svc, { name: 'my-key', algorithm: 'AES_256' }, { name: 'my-key', algorithm: 'AES_256' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateSymmetricKeyProps({ name: 'my-key', algorithm: 'AES_256' }),
      )
      expect(result.algorithm).toBe('AES_256')
    })

    test('rejects an unknown algorithm', async () => {
      const result = await runEffect(
        SchemaModule.validateSymmetricKeyProps({ algorithm: 'NOT_AN_ALGORITHM' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
