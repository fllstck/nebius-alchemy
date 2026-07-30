import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/iam/v1/group-membership'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.GroupMembership', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusGroupMembership).toBeDefined()
    expect(typeof Module.NebiusGroupMembership).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusGroupMembershipProvider).toBeDefined()
  })
})
