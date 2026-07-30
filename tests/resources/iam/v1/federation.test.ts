import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/iam/v1/federation'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.Federation', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusFederation).toBeDefined()
    expect(typeof Module.NebiusFederation).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusFederationProvider).toBeDefined()
  })
})
