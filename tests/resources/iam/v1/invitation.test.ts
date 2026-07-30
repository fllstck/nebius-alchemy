import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/iam/v1/invitation'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.Invitation', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusInvitation).toBeDefined()
    expect(typeof Module.NebiusInvitation).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusInvitationProvider).toBeDefined()
  })
})
