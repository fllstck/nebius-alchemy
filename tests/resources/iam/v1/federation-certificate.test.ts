import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/iam/v1/federation-certificate'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.FederationCertificate', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusFederationCertificate).toBeDefined()
    expect(typeof Module.NebiusFederationCertificate).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusFederationCertificateProvider).toBeDefined()
  })
})
