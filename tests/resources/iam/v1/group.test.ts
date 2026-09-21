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

/**
 * Convergence guard: every prop must be planned, reconciled, or declared.
 *
 * This diff compares an ENUMERATED field list, so a newly added prop would be
 * silently ignored — the engine turns any props change a diff ignores into an
 * `update` that writes nothing (`Plan.ts`). Adding a prop must therefore fail
 * here until someone decides how it converges. See AGENTS.md §Convergence.
 * (`labels` is the one declared exception: no update path sends labels.)
 */
describe('convergence guard', () => {
  test('every prop is planned or declared — adding one must fail this test', () => {
    expect(Object.keys(SchemaModule.GroupPropsSchema.fields).toSorted()).toEqual(['labels', 'name', 'parentId'])
  })
})
