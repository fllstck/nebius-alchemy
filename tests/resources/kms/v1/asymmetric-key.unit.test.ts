import * as BunTest from 'bun:test'
import * as AsymmetricKeyModule from '../../../../modules/resources/kms/v1/asymmetric-key'

const { describe, expect, test } = BunTest

describe('Nebius.kms.v1.AsymmetricKey', () => {
  test('NebiusAsymmetricKey resource constructor is defined', () => {
    expect(AsymmetricKeyModule.NebiusAsymmetricKey).toBeDefined()
    expect(typeof AsymmetricKeyModule.NebiusAsymmetricKey).toBe('function')
  })

  test('NebiusAsymmetricKeyProvider is defined', () => {
    expect(AsymmetricKeyModule.NebiusAsymmetricKeyProvider).toBeDefined()
  })
})
