import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/kms/v1/asymmetric-key.ts'
import * as SchemaModule from '../../../../modules/resources/kms/v1/asymmetric-key.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.kms.v1.AsymmetricKey', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusAsymmetricKey).toBeDefined()
    expect(typeof Module.NebiusAsymmetricKey).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusAsymmetricKeyProvider).toBeDefined()
  })

  describe('diff', () => {
    test('algorithm change requires replace (immutable)', async () => {
      const svc = await resolveProvider(Module.NebiusAsymmetricKey.Provider, Module.NebiusAsymmetricKeyProvider)
      expect(await runDiff(svc, { algorithm: 'RSA_4096_ENC_OAEP_SHA_256' }, { algorithm: 'ECDSA_NIST_P256_SHA_256' })).toEqual({ action: 'replace' })
    })

  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateAsymmetricKeyProps({ name: 'my-key', algorithm: 'ECDSA_NIST_P256_SHA_256' }),
      )
      expect(result.algorithm).toBe('ECDSA_NIST_P256_SHA_256')
    })

    test('rejects an unknown algorithm', async () => {
      const result = await runEffect(
        SchemaModule.validateAsymmetricKeyProps({ algorithm: 'DES_64' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
