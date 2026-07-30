import * as BunTest from 'bun:test'
import * as ZoneModule from '../../../../modules/resources/dns/v1/zone'

const { describe, expect, test } = BunTest

describe('Nebius.dns.v1.Zone', () => {
  test('NebiusZone resource constructor is defined', () => {
    expect(ZoneModule.NebiusZone).toBeDefined()
    expect(typeof ZoneModule.NebiusZone).toBe('function')
  })

  test('NebiusZoneProvider is defined', () => {
    expect(ZoneModule.NebiusZoneProvider).toBeDefined()
  })

  test('NebiusZoneProps and NebiusZoneAttributes types compile', () => {
    const provider = ZoneModule.NebiusZoneProvider
    expect(typeof provider).toBe('object')
  })
})
