import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/iam/v1/federated-credentials'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.FederatedCredentials', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusFederatedCredentials).toBeDefined()
    expect(typeof Module.NebiusFederatedCredentials).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusFederatedCredentialsProvider).toBeDefined()
  })
})
