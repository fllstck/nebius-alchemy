import * as BunTest from 'bun:test'
import * as ServiceAccountModule from '../../../../modules/resources/iam/v1/service-account'
import * as StaticKeyModule from '../../../../modules/resources/iam/v1/static-key'
import * as AccessKeyModule from '../../../../modules/resources/iam/v2/access-key'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.ServiceAccount', () => {
  test('NebiusServiceAccount resource constructor is defined', () => {
    expect(ServiceAccountModule.NebiusServiceAccount).toBeDefined()
    expect(typeof ServiceAccountModule.NebiusServiceAccount).toBe('function')
  })

  test('NebiusServiceAccountProvider is defined', () => {
    expect(ServiceAccountModule.NebiusServiceAccountProvider).toBeDefined()
  })
})

describe('Nebius.iam.v1.StaticKey', () => {
  test('NebiusStaticKey resource constructor is defined', () => {
    expect(StaticKeyModule.NebiusStaticKey).toBeDefined()
    expect(typeof StaticKeyModule.NebiusStaticKey).toBe('function')
  })

  test('NebiusStaticKeyProvider is defined', () => {
    expect(StaticKeyModule.NebiusStaticKeyProvider).toBeDefined()
  })
})

describe('Nebius.iam.v2.AccessKey', () => {
  test('NebiusAccessKey resource constructor is defined', () => {
    expect(AccessKeyModule.NebiusAccessKey).toBeDefined()
    expect(typeof AccessKeyModule.NebiusAccessKey).toBe('function')
  })

  test('NebiusAccessKeyProvider is defined', () => {
    expect(AccessKeyModule.NebiusAccessKeyProvider).toBeDefined()
  })
})
