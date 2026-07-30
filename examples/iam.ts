/**
 * ─────────────────────────────────────────────────────────────────────────────
 * IAM — ServiceAccount + StaticKey
 *
 * Creates a ServiceAccount and a StaticKey for programmatic access.
 * The static key token is only available at creation time — it is stored
 * in Alchemy state and printed to the console in this demo.
 *
 * Usage:
 *   alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID     (required)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  serviceAccountId: Nebius.iam.ServiceAccountId
  serviceAccountName: string
  serviceAccountActive: boolean
  staticKeyId: Nebius.iam.StaticKeyId
  staticKeyAccessKey: string
  staticKeyService: string
}

export default Alchemy.Stack(
  'IAM',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // Create a service account for programmatic access
    const sa = yield* Nebius.iam.ServiceAccount('DemoServiceAccount', {
      description: 'Demo service account for programmatic access to Nebius APIs',
      labels: { demo: 'iam' },
    })

    const sk = yield* Nebius.iam.StaticKey('DemoStaticKey', {
      serviceAccountId: sa.id,
      service: 'CONTAINER_REGISTRY',
    })

    return {
      serviceAccountId: sa.id,
      serviceAccountName: sa.name,
      serviceAccountActive: sa.active,
      staticKeyId: sk.id,
      staticKeyAccessKey: sk.accessKey,
      staticKeyService: sk.service,
    }
  }),
)
