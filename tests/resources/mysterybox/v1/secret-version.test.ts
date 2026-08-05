import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/mysterybox/v1/secret-version'
import * as SchemaModule from '../../../../modules/resources/mysterybox/v1/secret-version.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'

const { describe, expect, test } = BunTest

describe('Nebius.mysterybox.v1.SecretVersion', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusSecretVersion).toBeDefined()
    expect(typeof Module.NebiusSecretVersion).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusSecretVersionProvider).toBeDefined()
  })

  describe('diff', () => {
    test('parentId change requires replace (version can\'t move secrets)', async () => {
      const svc = await resolveProvider(Module.NebiusSecretVersion.Provider, Module.NebiusSecretVersionProvider)
      expect(await runDiff(svc, { parentId: 'secret-2' }, { parentId: 'secret-1' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusSecretVersion.Provider, Module.NebiusSecretVersionProvider)
      expect(await runDiff(svc, { parentId: 'secret-1' }, { parentId: 'secret-1' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateSecretVersionProps({
          parentId: 'secret-abc123' as SchemaModule.SecretVersionProps['parentId'],
          payload: [{ key: 'k', value: 'v' }],
        }),
      )
      expect(result.parentId).toBe('secret-abc123')
    })

    test('rejects props without a payload', async () => {
      const result = await runEffect(
        SchemaModule.validateSecretVersionProps({ parentId: 'secret-abc123' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
