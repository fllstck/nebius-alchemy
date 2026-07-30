import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/iam/v1/auth-public-key'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.AuthPublicKey', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusAuthPublicKey).toBeDefined()
    expect(typeof Module.NebiusAuthPublicKey).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusAuthPublicKeyProvider).toBeDefined()
  })
})
