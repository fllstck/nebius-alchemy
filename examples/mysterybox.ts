/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MysteryBox — Secret + SecretVersion
 *
 * Creates a Secret with an initial version and payload, then adds a second
 * version (v2) with updated credentials set as primary.
 *
 * The Secret omits `name` — auto-generated from the logical ID.
 * The SecretVersion provides `name: "v2"` explicitly as a semantic label.
 *
 * Usage:
 *   alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required)
 *   NEBIUS_PROJECT_ID     (required)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  secretId: string
  secretName: string
  secretState: string
  secretDescription: string
  effectiveKmsKeyId: string
  secretVersionId: string
  secretVersionName: string
  secretVersionState: string
  secretVersionDescription: string
}

export default Alchemy.Stack(
  'MysteryBox',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const secret = yield* Nebius.mysterybox.Secret('TestSecret', {
      description: 'MysteryBox demo secret',
      payloads: [
        { key: 'api_key', stringValue: 'sk-abc123def456' },
        { key: 'endpoint', stringValue: 'https://api.example.com' },
      ],
    })

    const version = yield* Nebius.mysterybox.SecretVersion('TestVersion', {
      parentId: secret.id,
      name: 'v2',
      description: 'Second version with updated credentials',
      payload: [
        { key: 'api_key', stringValue: 'sk-updated789xyz' },
        { key: 'endpoint', stringValue: 'https://api-v2.example.com' },
      ],
      setPrimary: true,
    })

    return {
      secretId: secret.id,
      secretName: secret.name,
      secretState: secret.state,
      secretDescription: secret.description,
      effectiveKmsKeyId: secret.effectiveKmsKeyId,
      secretVersionId: version.id,
      secretVersionName: version.name,
      secretVersionState: version.state,
      secretVersionDescription: version.description,
    }
  }),
)
