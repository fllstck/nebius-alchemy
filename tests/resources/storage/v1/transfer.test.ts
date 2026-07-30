import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/storage/v1/transfer'

const { describe, expect, test } = BunTest

describe('Nebius.storage.v1.Transfer', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusTransfer).toBeDefined()
    expect(typeof Module.NebiusTransfer).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusTransferProvider).toBeDefined()
  })
})
