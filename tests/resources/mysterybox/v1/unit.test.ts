import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/mysterybox/v1/secret.ts'
import * as SchemaModule from '../../../../modules/resources/mysterybox/v1/secret.schema.ts'
import { runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.mysterybox.v1.Secret', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusSecret).toBeDefined()
    expect(typeof Module.NebiusSecret).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusSecretProvider).toBeDefined()
  })


  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateSecretProps({ name: 'my-secret', description: 'creds' }),
      )
      expect(result.name).toBe('my-secret')
    })

    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(
        SchemaModule.validateSecretProps({ name: 'Bad Name!' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
