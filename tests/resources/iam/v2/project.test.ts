import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v2/project.ts'
import * as SchemaModule from '../../../../modules/resources/iam/v2/project.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v2.Project', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusProject).toBeDefined()
    expect(typeof Module.NebiusProject).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusProjectProvider).toBeDefined()
  })

  describe('diff', () => {

    test('region change is NOT a replace (in-place update)', async () => {
      const svc = await resolveProvider(Module.NebiusProject.Provider, Module.NebiusProjectProvider)
      expect(await runDiff(svc, { name: 'my-project', region: 'eu-west1' }, { name: 'my-project', region: 'eu-north1' })).toBeUndefined()
    })

  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateProjectProps({ name: 'my-project', region: 'eu-west1' }),
      )
      expect(result.region).toBe('eu-west1')
    })

    test('rejects an unknown region', async () => {
      const result = await runEffect(
        SchemaModule.validateProjectProps({ name: 'my-project', region: 'mars-1' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
