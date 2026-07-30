import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(!process.env.SLOW_TESTS)('Nebius.vpc.v1.SecurityRule lifecycle', (stack) =>
  Effect.gen(function* () {
    const { network, sg, rule } = yield* stack.deploy(
      Effect.gen(function* () {
        const network = yield* Nebius.vpc.Network('SRTest-Network', {})
        const sg = yield* Nebius.vpc.SecurityGroup('SRTest-SG', {
          networkId: network.id,
        })
        const rule = yield* Nebius.vpc.SecurityRule('SRTest-Rule', {
          parentId: sg.id,
          direction: 'INGRESS',
          protocol: 'TCP',
          access: 'ALLOW',
          ingress: {
            sourceCidrs: ['0.0.0.0/0'],
            destinationPorts: [443],
          },
        })
        return { network, sg, rule }
      }),
    )

    expect(network.id).toBeDefined()
    expect(sg.id).toBeDefined()
    expect(rule.id).toBeDefined()
    expect(typeof rule.id).toBe('string')
    expect(rule.parentId).toBe(sg.id)
    expect(rule.direction).toBe('INGRESS')
    expect(rule.protocol).toBe('TCP')
    expect(rule.access).toBe('ALLOW')
    expect(rule.state).toBe('READY')
  }).pipe(
    Effect.ensuring(stack.destroy().pipe(Effect.ignore)),
  ),
  { timeout: 180_000 },
)
