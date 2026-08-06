/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KMS — SymmetricKey and AsymmetricKey lifecycle
 *
 * Creates a SymmetricKey (AES_256) and an AsymmetricKey (ECDSA_NIST_P256_SHA_256).
 *
 * `name` is omitted from both key props — auto-generated from the
 * logical IDs (`"SymmetricKey"`, `"AsymmetricKey"`).
 *
 * Usage:
 *   alchemy deploy --yes
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  symmetricKeyId: string
  symmetricKeyName: string
  symmetricKeyState: string
  symmetricKeyAlgorithm: string
  asymmetricKeyId: string
  asymmetricKeyName: string
  asymmetricKeyState: string
  asymmetricKeyAlgorithm: string
}

export default Alchemy.Stack(
  'KMS',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const symmetricKey = yield* Nebius.kms.SymmetricKey('SymmetricKey', {
      algorithm: 'AES_256',
      description: 'KMS Demo symmetric key',
    })

    const asymmetricKey = yield* Nebius.kms.AsymmetricKey('AsymmetricKey', {
      algorithm: 'ECDSA_NIST_P256_SHA_256',
      description: 'KMS Demo asymmetric key',
    })

    return {
      symmetricKeyId: symmetricKey.id,
      symmetricKeyName: symmetricKey.name,
      symmetricKeyState: symmetricKey.state,
      symmetricKeyAlgorithm: symmetricKey.algorithm,
      asymmetricKeyId: asymmetricKey.id,
      asymmetricKeyName: asymmetricKey.name,
      asymmetricKeyState: asymmetricKey.state,
      asymmetricKeyAlgorithm: asymmetricKey.algorithm,
    }
  }) as any, // oxlint-disable-line no-explicit-any — stack output cast
)
