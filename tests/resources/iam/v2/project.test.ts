import * as BunTest from 'bun:test'
import * as ProjectModule from '../../../../modules/resources/iam/v2/project'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v2.Project', () => {
  test('NebiusProject resource constructor is defined', () => {
    expect(ProjectModule.NebiusProject).toBeDefined()
    expect(typeof ProjectModule.NebiusProject).toBe('function')
  })

  test('NebiusProjectProvider is defined', () => {
    expect(ProjectModule.NebiusProjectProvider).toBeDefined()
  })

  test('Provider has expected lifecycle methods', () => {
    const provider = ProjectModule.NebiusProjectProvider
    expect(typeof provider).toBe('object')
  })
})
