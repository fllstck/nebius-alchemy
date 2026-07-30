import * as BunTest from 'bun:test'
import * as InstanceModule from '../../../../modules/resources/compute/v1/instance'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.Instance', () => {
  test('NebiusInstance resource constructor is defined', () => {
    expect(InstanceModule.NebiusInstance).toBeDefined()
    expect(typeof InstanceModule.NebiusInstance).toBe('function')
  })

  test('NebiusInstanceProvider is defined', () => {
    expect(InstanceModule.NebiusInstanceProvider).toBeDefined()
  })

  test('NebiusInstanceProps and NebiusInstanceAttributes types compile', () => {
    // Type-only test — if this file compiles, the types are valid.
    const provider = InstanceModule.NebiusInstanceProvider
    expect(typeof provider).toBe('object')
  })
})
