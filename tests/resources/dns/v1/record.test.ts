import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/dns/v1/record.ts'
import * as SchemaModule from '../../../../modules/resources/dns/v1/record.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

const validRecordProps = {
  parentId: 'zone-abc123',
  relativeName: 'www',
  type: 'A',
  data: '10.0.0.1',
}

describe('Nebius.dns.v1.Record', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusRecord).toBeDefined()
    expect(typeof Module.NebiusRecord).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusRecordProvider).toBeDefined()
  })

  describe('diff', () => {
    test('zone change requires replace (records can\'t move zones)', async () => {
      const svc = await resolveProvider(Module.NebiusRecord.Provider, Module.NebiusRecordProvider)
      expect(await runDiff(svc, { parentId: 'zone-2' }, { parentId: 'zone-1' })).toEqual({ action: 'replace' })
    })

    test('type change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusRecord.Provider, Module.NebiusRecordProvider)
      expect(await runDiff(svc, { type: 'AAAA' }, { type: 'A' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusRecord.Provider, Module.NebiusRecordProvider)
      expect(await runDiff(svc, { parentId: 'zone-1', type: 'A' }, { parentId: 'zone-1', type: 'A' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SchemaModule.validateRecordProps(validRecordProps))
      expect(result.relativeName).toBe('www')
    })

    test('rejects an unknown record type', async () => {
      const result = await runEffect(
        SchemaModule.validateRecordProps({ ...validRecordProps, type: 'ZZZ' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
