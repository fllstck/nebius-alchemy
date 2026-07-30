import * as BunTest from 'bun:test'
import * as SymmetricKeyModule from '../../../../modules/resources/kms/v1/symmetric-key'

const { describe, expect, test } = BunTest

describe('Nebius.kms.v1.SymmetricKey', () => {
  test('NebiusSymmetricKey resource constructor is defined', () => {
    expect(SymmetricKeyModule.NebiusSymmetricKey).toBeDefined()
    expect(typeof SymmetricKeyModule.NebiusSymmetricKey).toBe('function')
  })

  test('NebiusSymmetricKeyProvider is defined', () => {
    expect(SymmetricKeyModule.NebiusSymmetricKeyProvider).toBeDefined()
  })
})
