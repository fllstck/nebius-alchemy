import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/dns/v1/zone.ts'
import * as SchemaModule from '../../../../modules/resources/dns/v1/zone.schema.ts'
import * as NebiusZoneSchema from '../../../../schemas/nebius/dns/v1/zone.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

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
      expect(await runDiff(svc, { ...validZoneProps, domainName: 'other.com.' }, { ...validZoneProps, domainName: 'example.com.' })).toEqual({ action: 'replace' })
    })

    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      expect(await runDiff(svc, { ...validZoneProps, name: 'new-zone' }, { ...validZoneProps, name: 'old-zone' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      expect(await runDiff(svc, { ...validZoneProps }, { ...validZoneProps })).toBeUndefined()
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

    // ── custom SOA (Task 7b schema-audit gaps) ────────────────────────────
    // `soa_spec` was in the generated ZoneSpec but absent from the props schema,
    // so the zone's negative-caching TTL could not be set at all.
    test('accepts a custom SOA negative TTL', async () => {
      const result = await runEffect(
        SchemaModule.validateZoneProps({ ...validZoneProps, soaSpec: { negativeTtl: 60 } }),
      )
      expect(result.soaSpec?.negativeTtl).toBe(60)
    })

    test('rejects a negative TTL below 5 seconds (the API ignores it silently)', async () => {
      const result = await runEffect(
        SchemaModule.validateZoneProps({ ...validZoneProps, soaSpec: { negativeTtl: 3 } }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects a fractional negative TTL', async () => {
      const result = await runEffect(
        SchemaModule.validateZoneProps({ ...validZoneProps, soaSpec: { negativeTtl: 30.5 } }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('serialises the SOA spec onto the wire through ZoneSpec.fromJSON', () => {
      // The provider passes the raw props to `ZoneSpec.fromJSON`, so the nested
      // message + its Long second count must survive that pass-through.
      const spec = NebiusZoneSchema.ZoneSpec.fromJSON({
        domainName: 'example.com.',
        vpc: { primaryNetworkId: 'network-abc123' },
        soaSpec: { negativeTtl: 60 },
      })
      expect(spec.soaSpec?.negativeTtl.toNumber()).toBe(60)
    })
  })
})
