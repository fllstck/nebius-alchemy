import { describe, expect, test } from 'bun:test'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import * as SaBootstrap from '../../modules/auth/sa-bootstrap.ts'

describe('SaBootstrap.generateKeyPair', () => {
  test('produces a matching RSA-4096 SPKI/PKCS8 PEM pair', () => {
    const { publicKeyPem, privateKeyPem } = SaBootstrap.generateKeyPair()

    expect(publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----')
    expect(privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----')

    // The platform rejects non-4096 authorized keys — the pair must parse
    // and report the required modulus length.
    const publicKey = createPublicKey(publicKeyPem)
    expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(4096)
    // The private key must be loadable and correspond to the public key.
    expect(() => createPrivateKey(privateKeyPem)).not.toThrow()
  })
})

describe('SaBootstrap constants', () => {
  test('bootstrap errors are tagged', () => {
    const error = new SaBootstrap.SaBootstrapError({ message: 'boom' })
    expect(error._tag).toBe('SaBootstrapError')
    expect(error.message).toBe('boom')
  })
})

/**
 * The bootstrap is the one flow a user cannot debug by re-reading their own
 * props, so its failures must name the gRPC status and the server's text.
 *
 * Regression: `callUnary` used the *thunk* form of `Effect.tryPromise`, which
 * wraps every rejection in Effect's `UnknownError` — the message users saw was
 * `Nebius IAM bootstrap call failed: An error occurred in Effect.tryPromise`,
 * naming neither the call nor the reason.
 */
describe('SaBootstrap.describeIamCallFailure', () => {
  test('renders the gRPC status name, code and the server details', () => {
    const rendered = SaBootstrap.describeIamCallFailure({
      code: 7, // PERMISSION_DENIED
      details: 'service account creation is not allowed',
      message: '7 PERMISSION_DENIED: service account creation is not allowed',
    })

    expect(rendered).toContain('PERMISSION_DENIED (7)')
    expect(rendered).toContain('service account creation is not allowed')
    // Never the Effect wrapper — that is the bug this pins.
    expect(rendered).not.toContain('An error occurred in Effect.tryPromise')
  })

  test('a permission failure names the missing IAM write access', () => {
    const rendered = SaBootstrap.describeIamCallFailure({ code: 7, details: 'permission denied' })
    expect(rendered).toContain('needs IAM write access on the tenant')
  })

  test('an unauthenticated failure suggests re-pasting the credential', () => {
    const rendered = SaBootstrap.describeIamCallFailure({ code: 16, details: 'token expired' })
    expect(rendered).toContain('UNAUTHENTICATED (16)')
    expect(rendered).toContain('may be expired or truncated')
  })

  test('falls back to `details`, then `message`, for an unknown status', () => {
    expect(SaBootstrap.describeIamCallFailure({ code: 13, details: 'internal oops' })).toContain('internal oops')
    expect(SaBootstrap.describeIamCallFailure({ code: 13, message: 'message only' })).toContain('message only')
  })

  test('renders non-gRPC rejections without crashing', () => {
    // A channel/endpoint error or a plain throw can reach here too.
    expect(SaBootstrap.describeIamCallFailure(new Error('socket closed'))).toContain('socket closed')
    expect(SaBootstrap.describeIamCallFailure('boom')).toContain('boom')
    expect(SaBootstrap.describeIamCallFailure(undefined)).toContain('undefined')
  })
})
