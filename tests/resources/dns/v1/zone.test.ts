import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Module from '../../../../modules/resources/dns/v1/zone.ts'
import * as SchemaModule from '../../../../modules/resources/dns/v1/zone.schema.ts'
import * as NebiusZoneSchema from '../../../../schemas/nebius/dns/v1/zone.ts'
import * as NebiusRecordSchema from '../../../../schemas/nebius/dns/v1/record.ts'
import { instanceIdLayer, mockDnsLayer, notFoundError, protoMetadata, stackLayer, testConfigLayer } from '../../../helpers/mocks.ts'
import { resolveProvider, runDelete, runDeleteExpectingError, runDiff, runEffect, runReconcile } from '../../../helpers/provider.ts'

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
      // Pinned name (`validZoneProps.name`) ⇒ delete-first — same identity.
      expect(await runDiff(svc, { ...validZoneProps, domainName: 'other.com.' }, { ...validZoneProps, domainName: 'example.com.' })).toEqual({ action: 'replace', deleteFirst: true })
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

  describe('reconcile (spec drift)', () => {
    /**
     * `soaSpec.negativeTtl` is an int64 (`Long`), and `AlchemyDiff.deepEqual`
     * canonicalizes every class instance — `Long` included — to `undefined`. So
     * `deepEqual(SoaSpec{300}, SoaSpec{60})` was `true` and the SOA branch of the
     * drift check was dead code: a negative-TTL change never converged.
     */
    const liveZone = (negativeTtl: number): NebiusZoneSchema.Zone => ({
      metadata: protoMetadata('zone-1', 'my-zone', 'project-test-1'),
      spec: NebiusZoneSchema.ZoneSpec.fromJSON({
        domainName: 'example.com.',
        vpc: { primaryNetworkId: 'network-abc123' },
        soaSpec: { negativeTtl: String(negativeTtl) },
      }),
      status: undefined,
    })

    const layerFor = (live: NebiusZoneSchema.Zone, updated: Array<{ spec?: NebiusZoneSchema.ZoneSpec }>) =>
      Effect.provide(
        Layer.mergeAll(
          mockDnsLayer({
            zone: {
              get: () => Effect.succeed(live),
              update: (req: { spec?: NebiusZoneSchema.ZoneSpec }) => {
                updated.push(req)
                return Effect.succeed(live)
              },
            },
          }),
          stackLayer,
          testConfigLayer,
          instanceIdLayer,
        ),
      )

    test('a pinned negative-TTL change is applied (regression: deepEqual blinded the int64)', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      const updated: Array<{ spec?: NebiusZoneSchema.ZoneSpec }> = []

      await runReconcile(
        svc,
        { ...validZoneProps, soaSpec: { negativeTtl: 60 } },
        { id: 'zone-1' },
        undefined,
        layerFor(liveZone(300), updated),
      )

      expect(updated).toHaveLength(1)
      expect(updated[0]!.spec!.soaSpec!.negativeTtl.toNumber()).toBe(60)
    })

    test('an unchanged negative TTL is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      const updated: Array<{ spec?: NebiusZoneSchema.ZoneSpec }> = []

      await runReconcile(
        svc,
        { ...validZoneProps, soaSpec: { negativeTtl: 60 } },
        { id: 'zone-1' },
        undefined,
        layerFor(liveZone(60), updated),
      )

      expect(updated).toHaveLength(0)
    })

    test('an omitted SOA spec never fires — the platform default must not drive an update loop', async () => {
      // The API answers with its own SOA when none was set, and it *ignores* a
      // negative TTL below 5 seconds — so comparing that echo (an omitted prop
      // encodes as 0) would rewrite the spec on every reconcile and never converge.
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      const updated: Array<{ spec?: NebiusZoneSchema.ZoneSpec }> = []

      await runReconcile(svc, validZoneProps, { id: 'zone-1' }, undefined, layerFor(liveZone(300), updated))

      expect(updated).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // delete — a zone with user records cannot be deleted
  // -------------------------------------------------------------------------
  describe('delete', () => {
    const zoneProto = (): NebiusZoneSchema.Zone => ({
      metadata: protoMetadata('zone-1', 'my-zone', 'project-test-1'),
      spec: NebiusZoneSchema.ZoneSpec.fromJSON({
        domainName: 'example.com.',
        vpc: { primaryNetworkId: 'network-abc123' },
      }),
      status: undefined,
    })

    /** A record as the API lists it: the wire `type` is the numeric enum, not the prop's string. */
    const recordProto = (relativeName: string, type: number, id = `dnsrecord-${relativeName}`) => ({
      metadata: protoMetadata(id, `${relativeName}-record`, 'zone-1'),
      spec: { relativeName, type, ttl: 600, data: '10.0.0.1' },
      status: undefined,
    })

    const NS = NebiusRecordSchema.RecordSpec_RecordType.NS
    const SOA = NebiusRecordSchema.RecordSpec_RecordType.SOA
    const A = NebiusRecordSchema.RecordSpec_RecordType.A

    const deleteLayer = (records: ReadonlyArray<unknown>, deletedIds: string[], get: () => Effect.Effect<unknown, unknown>) =>
      Effect.provide(
        Layer.mergeAll(
          mockDnsLayer({
            zone: {
              get,
              delete: (id: string) => {
                deletedIds.push(id)
                return Effect.void
              },
            },
            record: { list: () => Effect.succeed(records) },
          }),
          stackLayer,
          testConfigLayer,
          instanceIdLayer,
        ),
      )

    test('refuses while a USER record remains, naming it and never calling delete', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      const deletedIds: string[] = []
      const error = await runDeleteExpectingError(
        svc,
        { id: 'zone-1' },
        undefined,
        deleteLayer(
          [recordProto('www', A), recordProto('@', NS), recordProto('@', SOA)],
          deletedIds,
          () => Effect.succeed(zoneProto()),
        ),
      )

      expect(error._tag).toBe('ZoneNotEmpty')
      expect(error.records).toEqual(['www (A)'])
      expect(error.message).toContain('www (A)')
      expect(error.message).toContain('re-run the destroy')
      // The refusal is a pre-check, not a retried API failure — so the delete was never issued, and the
      // generic 9-FAILED_PRECONDITION retry (20 s × 12) never runs.
      expect(deletedIds).toEqual([])
    })

    test('deletes when only the zone’s own NS and SOA records remain', async () => {
      // Measured 2026-09-24: every VPC zone carries them, deleting either is refused, and they do NOT block
      // the zone's own delete — so a pre-check that counted them would make every zone undeletable.
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      const deletedIds: string[] = []
      await runDelete(
        svc,
        { id: 'zone-1' },
        undefined,
        deleteLayer(
          [recordProto('@', NS), recordProto('@', SOA)],
          deletedIds,
          () => Effect.succeed(zoneProto()),
        ),
      )
      expect(deletedIds).toEqual(['zone-1'])
    })

    test('an already-deleted zone is a no-op (idempotent destroy)', async () => {
      const svc = await resolveProvider(Module.NebiusZone.Provider, Module.NebiusZoneProvider)
      const deletedIds: string[] = []
      await runDelete(
        svc,
        { id: 'zone-1' },
        undefined,
        deleteLayer([recordProto('www', A)], deletedIds, () => Effect.fail(notFoundError())),
      )
      expect(deletedIds).toEqual([])
    })
  })
})
