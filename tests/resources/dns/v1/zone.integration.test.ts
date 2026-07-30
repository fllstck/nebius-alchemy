import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.dns.v1.Zone lifecycle', (stack) =>
  Effect.gen(function* () {
    const { network, zone } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('ZoneTest-Network', {})
        const zone = yield* Nebius.dns.Zone('ZoneTest-Zone', {
          domainName: 'alchemy-test.example.com.',
          vpc: { primaryNetworkId: network.id },
        })
        return { network, zone }
      }),
    )

    expect(network.id).toBeDefined()
    expect(zone.id).toBeDefined()
    expect(typeof zone.id).toBe('string')
    expect(zone.domainName).toBe('alchemy-test.example.com.')
    expect(zone.state).toBe('READY')
  }).pipe(
    Effect.ensuring(stack.destroy().pipe(Effect.ignore)),
  ),
  { timeout: 120_000 },
)
