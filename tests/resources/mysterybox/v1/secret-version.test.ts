import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/mysterybox/v1/secret-version'

const { describe, expect, test } = BunTest

describe('Nebius.mysterybox.v1.SecretVersion', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusSecretVersion).toBeDefined()
    expect(typeof Module.NebiusSecretVersion).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusSecretVersionProvider).toBeDefined()
  })
})
