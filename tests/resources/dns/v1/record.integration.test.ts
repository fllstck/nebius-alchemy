import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const { test } = Test.make({ providers: Nebius.providers() as any })

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
    Effect.ensuring(safeDestroy(stack)),
  ),
  { timeout: 180_000 },
)
