import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Module from '../../../../modules/resources/dns/v1/record.ts'
import * as SchemaModule from '../../../../modules/resources/dns/v1/record.schema.ts'
import * as NebiusRecordSchema from '../../../../schemas/nebius/dns/v1/record.ts'
import { instanceIdLayer, mockDnsLayer, protoMetadata, stackLayer, testConfigLayer } from '../../../helpers/mocks.ts'
import { resolveProvider, runDiff, runEffect, runReconcile } from '../../../helpers/provider.ts'

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
      expect(await runDiff(svc, { ...validRecordProps, parentId: 'zone-2' }, { ...validRecordProps, parentId: 'zone-1' })).toEqual({ action: 'replace' })
    })

    test('type change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusRecord.Provider, Module.NebiusRecordProvider)
      expect(await runDiff(svc, { ...validRecordProps, type: 'AAAA' }, { ...validRecordProps, type: 'A' })).toEqual({ action: 'replace' })
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

    describe('ttl bounds — measured live 2026-09-24 (spikes/dns-ttl-bounds-probe.ts)', () => {
      const ttlError = async (ttl: number) =>
        String(await runEffect(SchemaModule.validateRecordProps({ ...validRecordProps, ttl }).pipe(Effect.flip)))

      test('accepts the boundaries: 1 and INT32_MAX', async () => {
        // Both were accepted *and echoed back unchanged* in the probe, so they are inside the range.
        expect((await runEffect(SchemaModule.validateRecordProps({ ...validRecordProps, ttl: 1 }))).ttl).toBe(1)
        expect(
          (await runEffect(SchemaModule.validateRecordProps({ ...validRecordProps, ttl: 2147483647 }))).ttl,
        ).toBe(2147483647)
      })

      test('rejects a ttl above INT32_MAX — the API answers a bare "Invalid Record TTL"', async () => {
        // `2147483648` and `4294967295` were both refused; the message names no bound, which is why the real
        // range is worth stating at plan time.
        expect(await ttlError(2147483648)).toContain('between 1 and 2147483647')
        expect(await ttlError(4294967295)).toContain('between 1 and 2147483647')
      })

      test('rejects 0 and negatives — the API accepts them and silently stores 600', async () => {
        // This is the loop, not a nicety: the provider compares the live echo against the pinned value
        // (`news.ttl !== undefined &&`), and the echo is 600, so a pinned `0` writes an update on every
        // reconcile that can never converge.
        expect(await ttlError(0)).toContain('silently replaced with its default 600')
        expect(await ttlError(-1)).toContain('silently replaced with its default 600')
      })

      test('rejects a fractional ttl — 0.5 also comes back as 600, never a truncation', async () => {
        expect(await ttlError(0.5)).toContain('whole number of seconds')
      })

      test('omitting ttl is still fine (the API default is 600)', async () => {
        const result = await runEffect(SchemaModule.validateRecordProps(validRecordProps))
        expect(result.ttl).toBeUndefined()
      })
    })
  })

  describe('reconcile (spec drift)', () => {
    /**
     * `RecordSpec.ttl` is an int64 (`Long`), and `AlchemyDiff.deepEqual`
     * canonicalizes every class instance — `Long` included — to `undefined`. So
     * `deepEqual(Long 60, Long 600)` is `true` and the drift check was dead code:
     * a TTL change planned an update that never fired. The update count is the
     * only assertion that catches it (an assertion on `updated[0]` alone would
     * pass vacuously against `undefined` under a non-null assertion).
     */
    const liveRecord = (ttl: number): NebiusRecordSchema.Record => ({
      metadata: protoMetadata('record-1', 'www-a', 'zone-1'),
      spec: NebiusRecordSchema.RecordSpec.fromJSON({
        relativeName: 'www',
        type: 'A',
        data: '10.0.0.1',
        ttl: String(ttl),
      }),
      status: undefined,
    })

    const layerFor = (live: NebiusRecordSchema.Record, updated: Array<{ spec?: NebiusRecordSchema.RecordSpec }>) =>
      Effect.provide(
        Layer.mergeAll(
          mockDnsLayer({
            record: {
              get: () => Effect.succeed(live),
              update: (req: { spec?: NebiusRecordSchema.RecordSpec }) => {
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

    test('a TTL change is applied — the int64 is visible (regression: deepEqual blinded it)', async () => {
      const svc = await resolveProvider(Module.NebiusRecord.Provider, Module.NebiusRecordProvider)
      const updated: Array<{ spec?: NebiusRecordSchema.RecordSpec }> = []

      await runReconcile(
        svc,
        { ...validRecordProps, ttl: 600 },
        { id: 'record-1' },
        undefined,
        layerFor(liveRecord(60), updated),
      )

      expect(updated).toHaveLength(1)
      expect(String(updated[0]!.spec!.ttl)).toBe('600')
    })

    test('an unchanged TTL is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusRecord.Provider, Module.NebiusRecordProvider)
      const updated: Array<{ spec?: NebiusRecordSchema.RecordSpec }> = []

      await runReconcile(
        svc,
        { ...validRecordProps, ttl: 60 },
        { id: 'record-1' },
        undefined,
        layerFor(liveRecord(60), updated),
      )

      expect(updated).toHaveLength(0)
    })

    test('an omitted TTL never fires — the API echo must not drive an update loop', async () => {
      // `ttl` is optional in props but a non-optional int64 on the wire: an omitted
      // prop encodes as 0, which the API reads as "use the default" (600) and answers
      // with a real TTL. Comparing that echo would rewrite the spec on every reconcile.
      const svc = await resolveProvider(Module.NebiusRecord.Provider, Module.NebiusRecordProvider)
      const updated: Array<{ spec?: NebiusRecordSchema.RecordSpec }> = []

      await runReconcile(
        svc,
        { parentId: 'zone-1', relativeName: 'www', type: 'A', data: '10.0.0.1' },
        { id: 'record-1' },
        undefined,
        layerFor(liveRecord(600), updated),
      )

      expect(updated).toHaveLength(0)
    })
  })
})
