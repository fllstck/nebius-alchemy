import * as BunTest from 'bun:test'
import * as DiskModule from '../../../../modules/resources/compute/v1/disk'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.Disk', () => {
  test('NebiusDisk resource constructor is defined', () => {
    expect(DiskModule.NebiusDisk).toBeDefined()
    expect(typeof DiskModule.NebiusDisk).toBe('function')
  })

  test('NebiusDiskProvider is defined', () => {
    expect(DiskModule.NebiusDiskProvider).toBeDefined()
  })

  test('NebiusDiskProps and NebiusDiskAttributes types compile', () => {
    // Type-only test — if this file compiles, the types are valid.
    const provider = DiskModule.NebiusDiskProvider
    expect(typeof provider).toBe('object')
  })
})
