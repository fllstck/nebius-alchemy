import * as BunTest from 'bun:test'
import * as RecordModule from '../../../../modules/resources/dns/v1/record'

const { describe, expect, test } = BunTest

describe('Nebius.dns.v1.Record', () => {
  test('NebiusRecord resource constructor is defined', () => {
    expect(RecordModule.NebiusRecord).toBeDefined()
    expect(typeof RecordModule.NebiusRecord).toBe('function')
  })

  test('NebiusRecordProvider is defined', () => {
    expect(RecordModule.NebiusRecordProvider).toBeDefined()
  })

  test('NebiusRecordProps and NebiusRecordAttributes types compile', () => {
    const provider = RecordModule.NebiusRecordProvider
    expect(typeof provider).toBe('object')
  })
})
