import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/mysterybox/v1/secret-version.ts'
import * as SchemaModule from '../../../../modules/resources/mysterybox/v1/secret-version.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.mysterybox.v1.SecretVersion', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusSecretVersion).toBeDefined()
    expect(typeof Module.NebiusSecretVersion).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusSecretVersionProvider).toBeDefined()
  })

  describe('diff', () => {
    // Payload entries use the schema's own field name (`stringValue`): the diff
    // validates `news` before comparing, and an unknown key like `value` is
    // stripped by the decoder — so a change only exists if a REAL field varies.
    const base = { parentId: 'secret-abc111', payload: [{ key: 'k', stringValue: 'v' }] }

    const diff = async (news: unknown, olds: unknown = base) => {
      const svc = await resolveProvider(Module.NebiusSecretVersion.Provider, Module.NebiusSecretVersionProvider)
      return runDiff(svc, news, olds)
    }

    // The service has NO Update RPC: every spec field must plan a replace, or the
    // change is silently lost (an `update` that writes nothing). These four cases
    // pin exactly the bug this diff had — and they assert `deleteFirst`, because
    // the generated name is `sv-<logicalId>` on every generation.
    test('description change replaces the version (delete-first)', async () => {
      expect(await diff({ ...base, description: 'changed' }, { ...base, description: 'original' })).toEqual({
        action: 'replace',
        deleteFirst: true,
      })
    })

    test('payload change replaces the version (delete-first)', async () => {
      expect(await diff({ ...base, payload: [{ key: 'k', stringValue: 'new' }] })).toEqual({
        action: 'replace',
        deleteFirst: true,
      })
    })

    test('setPrimary change replaces the version (delete-first)', async () => {
      expect(await diff({ ...base, setPrimary: true })).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('an absent prop and its falsy default are the same version (no spurious replace)', async () => {
      expect(
        await diff({ ...base, description: '', setPrimary: false }, { ...base, description: undefined }),
      ).toBeUndefined()
    })

    test('labels-only change is a noop (declared exception — no update path sends labels)', async () => {
      expect(await diff({ ...base, labels: { a: '1' } }, { ...base, labels: { a: '2' } })).toBeUndefined()
    })

    test("parentId change requires replace (version can't move secrets)", async () => {
      expect(await diff({ ...base, parentId: 'secret-abc222' })).toEqual({ action: 'replace' })
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateSecretVersionProps({
          parentId: 'secret-abc123' as SchemaModule.SecretVersionProps['parentId'],
          payload: [{ key: 'k', value: 'v' }],
        }),
      )
      expect(result.parentId).toBe('secret-abc123')
    })

    test('rejects props without a payload', async () => {
      const result = await runEffect(
        SchemaModule.validateSecretVersionProps({ parentId: 'secret-abc123' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
