/**
 * DNS — creates a VPC, a zone, and a record within it.
 *
 * Usage:
 *   alchemy deploy --yes    (from the project root)
 *   alchemy destroy --yes
 *
 * Environment:
 *   NEBIUS_API_KEY           Nebius IAM API key (auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID        Nebius project ID
 *
 * This stack creates:
 *   1. A VPC network for DNS zone scope
 *   2. A DNS zone (VPC-scoped) for `alchemy-demo-test.com.`
 *   3. An A record pointing `@` (the zone apex) to `192.0.2.1`
 */

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  networkId: string
  zoneId: string
  zoneName: string
  recordId: string
  recordFqdn: string
}

export default Alchemy.Stack(
  'DNS',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const network = yield* Nebius.vpc.Network('DnsDemoNetwork', {
      labels: { demo: 'dns' },
    })

    const zone = yield* Nebius.dns.Zone('DemoZone', {
      domainName: 'alchemy-demo-test.com.',
      vpc: { primaryNetworkId: network.id },
      labels: { demo: 'dns' },
    })

    const record = yield* Nebius.dns.Record('DemoRecord', {
      parentId: zone.id,
      relativeName: '@',
      type: 'A',
      data: '192.0.2.1',
    })

    return {
      networkId: network.id,
      zoneId: zone.id,
      zoneName: zone.name,
      recordId: record.id,
      recordFqdn: record.effectiveFqdn,
    }
  }),
)
