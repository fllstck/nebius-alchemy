import * as BunTest from 'bun:test'
import * as SecretModule from '../../../../modules/resources/mysterybox/v1/secret'

const { describe, expect, test } = BunTest

describe('Nebius.mysterybox.v1.Secret', () => {
  test('NebiusSecret resource constructor is defined', () => {
    expect(SecretModule.NebiusSecret).toBeDefined()
    expect(typeof SecretModule.NebiusSecret).toBe('function')
  })

  test('NebiusSecretProvider is defined', () => {
    expect(SecretModule.NebiusSecretProvider).toBeDefined()
  })
})
