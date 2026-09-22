import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as DnsGrpc from '../../../../modules/api-client/dns.ts'

integrationTest(test.provider, 'Nebius.dns.v1.Record lifecycle', (stack) =>
  Effect.gen(function* () {
    const { network, zone, record } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('RecTest-Network', {})
        const zone = yield* Nebius.dns.Zone('RecTest-Zone', {
          domainName: 'alchemy-test-rec.example.com.',
          vpc: { primaryNetworkId: network.id },
        })
        const record = yield* Nebius.dns.Record('RecTest-Record', {
          parentId: zone.id,
          relativeName: '@',
          type: 'A',
          data: '192.0.2.1',
          ttl: 300,
        })
        return { network, zone, record }
      }),
    )

    expect(network.id).toBeDefined()
    expect(zone.id).toBeDefined()
    expect(record.id).toBeDefined()
    expect(typeof record.id).toBe('string')
    expect(record.type).toBe('A')
    expect(record.data).toBe('192.0.2.1')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 180_000 },
)

// ---------------------------------------------------------------------------
// Update path — TASKS.md §"What is left" A: the 2026-09-21 convergence fixes
// are verified against mocks that encode an assumption. This settles two:
//
//   1. a `ttl` change is a real IN-PLACE update (same id, new value) — the API
//      accepts `RecordService/Update` with a changed `ttl`;
//   2. REMOVING the optional `ttl` prop from the config is not a reset. It is a
//      props change the `diff` ignores, so the framework plans `action: update`
//      and reconcile runs — the `news.ttl !== undefined &&` guard must then
//      write NOTHING (the old blind comparison re-sent the platform's own
//      default, and the value never converged).
//
// The oracle for "no write happened" is `metadata.resourceVersion`: the API
// bumps it on every accepted update, so an unchanged version across a reconcile
// that was planned as an update is proof that no write reached the wire.

/** Zone + network + apex A record, with the TTL under test. */
const declareTtlRecord = (ttl: number | undefined) =>
  Effect.gen(function* () {
    const network = yield* Nebius.vpc.Network('RecTtl-Network', {})
    const zone = yield* Nebius.dns.Zone('RecTtl-Zone', {
      domainName: 'alchemy-test-rec-ttl.example.com.',
      vpc: { primaryNetworkId: network.id },
    })
    const record = yield* Nebius.dns.Record('RecTtl-Record', {
      parentId: zone.id,
      relativeName: '@',
      type: 'A',
      data: '192.0.2.1',
      ...(ttl === undefined ? {} : { ttl }),
    })
    return record
  })

integrationTest(
  test.provider,
  'Nebius.dns.v1.Record — ttl converges in place, and omitting it is not a reset',
  (stack) =>
    Effect.gen(function* () {
      const dns = yield* DnsGrpc.DnsGrpcService
      /** Live wire state: `ttl` is an int64 (`Long`) plus the version counter. */
      const live = (id: string) =>
        dns.record.get(id).pipe(
          Effect.map((raw) => ({
            ttl: Number(raw.spec!.ttl),
            version: raw.metadata!.resourceVersion.toString(),
          })),
        )

      // 1. Create, TTL pinned at 300.
      const created = yield* stack.deploy(declareTtlRecord(300))
      const afterCreate = yield* live(created.id)
      expect(afterCreate.ttl).toBe(300)
      expect(Number(created.ttl)).toBe(300)
      console.log(`PROBE record ttl: created ttl=${afterCreate.ttl} version=${afterCreate.version}`)

      // 2. Drop the prop from the config. Props changed, `diff` ignores it → the
      //    framework plans an update → reconcile runs → the guard must not write.
      const omitted = yield* stack.deploy(declareTtlRecord(undefined))
      const afterOmit = yield* live(created.id)
      expect(omitted.id).toBe(created.id)
      expect(afterOmit.ttl).toBe(300)
      expect(afterOmit.version).toBe(afterCreate.version)

      // 3. Change the pinned TTL: an in-place update, same id, same name.
      const updated = yield* stack.deploy(declareTtlRecord(600))
      const afterUpdate = yield* live(created.id)
      expect(updated.id).toBe(created.id)
      expect(updated.name).toBe(created.name)
      expect(afterUpdate.ttl).toBe(600)
      expect(afterUpdate.version).not.toBe(afterCreate.version)
      console.log(`PROBE record ttl: in-place update accepted, version=${afterUpdate.version}`)

      // 4. Omit it again — the same guard, now against a value the user set.
      const omittedAgain = yield* stack.deploy(declareTtlRecord(undefined))
      const afterSecondOmit = yield* live(created.id)
      expect(omittedAgain.id).toBe(created.id)
      expect(afterSecondOmit.ttl).toBe(600)
      expect(afterSecondOmit.version).toBe(afterUpdate.version)
    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 300_000 },
)
