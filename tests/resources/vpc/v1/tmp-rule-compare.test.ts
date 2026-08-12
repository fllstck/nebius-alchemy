/**
 * DIAGNOSTIC (temporary, SLOW_TESTS-gated): compare the FULL state of
 * provider-created SecurityRules vs a raw-gRPC (CLI-style) rule — the hosted
 * e2e's instances attached to provider-created rules were filtered while the
 * same SG with CLI-created rules worked. Dump spec + status for both and diff.
 *
 * Run: SLOW_TESTS=1 bun test tests/resources/vpc/v1/tmp-rule-compare.test.ts
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as VpcGrpc from '../../../../modules/api-client/vpc.ts'
import * as VpcRuleSchema from '../../../../schemas/nebius/vpc/v1/security_rule.ts'
import * as VpcIds from '../../../../modules/resources/vpc/v1/ids.ts'

const DEFAULT_NETWORK = 'vpcnetwork-e00kr4njd4pyt8g8r6' as VpcIds.NetworkId

const dump = (rule: unknown) => JSON.stringify(rule, null, 1)

integrationTest(
  test.provider,
  'DIAG: provider-created vs CLI-style security rule state',
  (stack) =>
    Effect.gen(function* () {
      const vpc = yield* VpcGrpc.VpcGrpcService

      // Provider path: SG + 2 rules (create + drift-update happens in reconcile).
      yield* stack.deploy(
        Effect.gen(function* () {
          const sg = yield* Nebius.vpc.SecurityGroup('DiagSG', { networkId: DEFAULT_NETWORK })
          yield* Nebius.vpc.SecurityRule('DiagIngress', {
            parentId: sg.id,
            direction: 'INGRESS',
            protocol: 'TCP',
            access: 'ALLOW',
            ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
          })
          yield* Nebius.vpc.SecurityRule('DiagEgress', {
            parentId: sg.id,
            direction: 'EGRESS',
            protocol: 'ANY',
            access: 'ALLOW',
            egress: { destinationCidrs: ['0.0.0.0/0'] },
          })
        }),
      )

      // After the deploy, resolve the concrete SG id (no Outputs here).
      const sgList = yield* vpc.securityGroup.listByNetwork(String(DEFAULT_NETWORK))
      const diagSg = sgList.find(
        (s) => (s.metadata?.labels as Record<string, string> | undefined)?.['alchemy::id'] === 'DiagSG',
      )
      if (!diagSg) return yield* Effect.die(new Error('DiagSG not found by label'))
      const sgId = diagSg.metadata!.id
      console.log(`[diag] resolved DiagSG id=${sgId} state=${diagSg.status?.state}`)

      const providerRules = yield* vpc.securityRule.list(sgId)
      const providerIngress = providerRules.find((r) => r.spec?.ingress !== undefined)!
      const providerEgress = providerRules.find((r) => r.spec?.egress !== undefined)!
      const providerIngressId = providerIngress.metadata!.id
      const providerEgressId = providerEgress.metadata!.id
      console.log(`[diag] provider rules: ingress=${providerIngressId} egress=${providerEgressId}`)

      // CLI-style rule on the same SG via raw gRPC (what `nebius ... create` sends:
      // no alchemy labels, no priority/type → platform defaults).
      const cliStyle = yield* vpc.securityRule.create({
        metadata: { parentId: sgId, name: 'cli-style-rule' },
        spec: VpcRuleSchema.SecurityRuleSpec.fromJSON({
          access: 'ALLOW',
          protocol: 'TCP',
          ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
        }),
      })
      const cliStyleId = cliStyle.metadata!.id
      console.log(`[diag] cli-style rule: ${cliStyleId}`)

      // Full dumps (fresh gets — the list entries are snapshots).
      const providerIngressLive = yield* vpc.securityRule.get(providerIngressId)
      const providerEgressLive = yield* vpc.securityRule.get(providerEgressId)
      const cliRule = yield* vpc.securityRule.get(cliStyleId)

      console.log('[diag] === PROVIDER ingress (full) ===')
      console.log(dump(providerIngressLive))
      console.log('[diag] === PROVIDER egress (full) ===')
      console.log(dump(providerEgressLive))
      console.log('[diag] === CLI-STYLE (full) ===')
      console.log(dump(cliRule))

      expect(providerIngressId).toBeDefined()
    }).pipe(safeDestroy(stack)),
  { timeout: 5 * 60 * 1000 },
)
