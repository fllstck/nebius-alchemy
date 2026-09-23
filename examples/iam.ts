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
  /** The S3-compatible credential pair (v2 `AccessKey`) — see the warning below. */
  accessKeyId: Nebius.iam.AccessKeyId
  awsAccessKeyId: string
  /** ⚠️ A secret. Returned so the demo can show it; do not print state in shared logs. */
  secretAccessKey: string
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

    // StaticKey issues a token for a *service* (CONTAINER_REGISTRY here) — the non-standard
    // `Issue` lifecycle: the token exists only in the issue response, so it is captured into
    // state at create time and can never be re-read from the API.
    const sk = yield* Nebius.iam.StaticKey('DemoStaticKey', {
      serviceAccountId: sa.id,
      service: 'CONTAINER_REGISTRY',
    })

    // v2 `AccessKey` is the **S3-compatible** credential pair (an AWS-style
    // `awsAccessKeyId`/`secretAccessKey`), which is what Object Storage needs — a StaticKey
    // is not an S3 credential. Same one-time-secret rule: `secretDeliveryMode` defaults to
    // INLINE, so the secret is captured here and cannot be fetched again.
    //
    // ⚠️ The secret lands in Alchemy state in plaintext (`alchemy.localState()` writes a local
    // file). For anything real, use MYSTERY_BOX delivery instead and read the key material from
    // the MysteryBox secret it references:
    //   secretDeliveryMode: 'MYSTERY_BOX'
    const accessKey = yield* Nebius.iam.AccessKey('DemoAccessKey', {
      serviceAccountId: sa.id,
      description: 'S3-compatible credentials for the demo service account',
      // Omit `expiresAt` for a non-expiring key; ISO dates are accepted otherwise:
      //   expiresAt: '2027-01-01T00:00:00Z'
    })

    return {
      serviceAccountId: sa.id,
      serviceAccountName: sa.name,
      serviceAccountActive: sa.active,
      staticKeyId: sk.id,
      staticKeyAccessKey: sk.accessKey,
      staticKeyService: sk.service,
      accessKeyId: accessKey.id,
      awsAccessKeyId: accessKey.awsAccessKeyId,
      secretAccessKey: accessKey.secretAccessKey,
    }
  }),
)
