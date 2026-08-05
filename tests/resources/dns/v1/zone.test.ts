import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/dns/v1/zone'
import * as SchemaModule from '../../../../modules/resources/dns/v1/zone.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'

const { describe, expect, test } = BunTest

const validZoneProps = {
  name: 'my-zone',
  domainName: 'example.com.',
  vpc: { primaryNetworkId: 'network-abc123' },
}

describe('Nebius.dns.v1.Zone', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusZone).toBeDefined()
    expect(typeof Module.NebiusZone).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusZoneProvider).toBeDefined()
  })

  describe('diff', () => {
    test('domainName change requires replace (immutable)', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      expect(await runDiff(svc, { domainName: 'other.com.' }, { domainName: 'example.com.' })).toEqual({ action: 'replace' })
    })

    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      expect(await runDiff(svc, { name: 'new-zone' }, { name: 'old-zone' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      expect(await runDiff(svc, { name: 'my-zone', domainName: 'example.com.' }, { name: 'my-zone', domainName: 'example.com.' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SchemaModule.validateZoneProps(validZoneProps))
      expect(result.domainName).toBe('example.com.')
    })

    test('rejects props without the required vpc scope', async () => {
      const result = await runEffect(
        SchemaModule.validateZoneProps({ name: 'my-zone', domainName: 'example.com.' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
