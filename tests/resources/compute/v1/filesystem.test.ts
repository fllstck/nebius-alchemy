import * as BunTest from 'bun:test'
import * as Module from '../../../../modules/resources/compute/v1/filesystem'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.Filesystem', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusFilesystem).toBeDefined()
    expect(typeof Module.NebiusFilesystem).toBe('function')
  })
  test('provider is defined', () => {
    expect(Module.NebiusFilesystemProvider).toBeDefined()
  })
})
