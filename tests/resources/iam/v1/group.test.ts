import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/iam/v1/group'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.Group', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusGroup).toBeDefined()
    expect(typeof Module.NebiusGroup).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusGroupProvider).toBeDefined()
  })
})
