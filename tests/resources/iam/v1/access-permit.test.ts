import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/iam/v1/access-permit'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.AccessPermit', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusAccessPermit).toBeDefined()
    expect(typeof Module.NebiusAccessPermit).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusAccessPermitProvider).toBeDefined()
  })
})
