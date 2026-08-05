import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/auth-public-key'
import * as SchemaModule from '../../../../modules/resources/iam/v1/auth-public-key.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'

const { describe, expect, test } = BunTest

const PEM_KEY = '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----'

describe('Nebius.iam.v1.AuthPublicKey', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusAuthPublicKey).toBeDefined()
    expect(typeof Module.NebiusAuthPublicKey).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusAuthPublicKeyProvider).toBeDefined()
  })

  describe('diff', () => {
    test('accountId change requires replace (immutable)', async () => {
      const svc = await resolveProvider(Module.NebiusAuthPublicKey.Provider, Module.NebiusAuthPublicKeyProvider)
      expect(await runDiff(svc, { accountId: 'sa-2' }, { accountId: 'sa-1' })).toEqual({ action: 'replace' })
    })

    test('data change requires replace (immutable)', async () => {
      const svc = await resolveProvider(Module.NebiusAuthPublicKey.Provider, Module.NebiusAuthPublicKeyProvider)
      expect(await runDiff(svc, { data: 'key-b' }, { data: 'key-a' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusAuthPublicKey.Provider, Module.NebiusAuthPublicKeyProvider)
      expect(await runDiff(svc, { accountId: 'sa-1', data: 'key-a' }, { accountId: 'sa-1', data: 'key-a' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateAuthPublicKeyProps({
          accountId: 'serviceaccount-abc123' as SchemaModule.AuthPublicKeyProps['accountId'],
          data: PEM_KEY,
        }),
      )
      expect(result.accountId).toBe('serviceaccount-abc123')
    })

    test('rejects non-PEM key data', async () => {
      const result = await runEffect(
        SchemaModule.validateAuthPublicKeyProps({ accountId: 'sa-abc123', data: 'not a key' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
