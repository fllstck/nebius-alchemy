import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/group.ts'
import * as SchemaModule from '../../../../modules/resources/iam/v1/group.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.Group', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusGroup).toBeDefined()
    expect(typeof Module.NebiusGroup).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusGroupProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusGroup.Provider, Module.NebiusGroupProvider)
      expect(await runDiff(svc, { name: 'new-group' }, { name: 'old-group' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusGroup.Provider, Module.NebiusGroupProvider)
      expect(await runDiff(svc, { name: 'my-group' }, { name: 'my-group' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateGroupProps({ name: 'my-group' }),
      )
      expect(result.name).toBe('my-group')
    })

    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(
        SchemaModule.validateGroupProps({ name: 'Not Valid!' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
