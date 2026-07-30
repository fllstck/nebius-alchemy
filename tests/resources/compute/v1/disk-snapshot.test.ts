import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/compute/v1/disk-snapshot'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.DiskSnapshot', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusDiskSnapshot).toBeDefined()
    expect(typeof Module.NebiusDiskSnapshot).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusDiskSnapshotProvider).toBeDefined()
  })
})
