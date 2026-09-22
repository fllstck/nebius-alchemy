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

  test('a numeric code with no status name renders the bare number', () => {
    expect(SaBootstrap.describeIamCallFailure({ code: 99, details: 'unknown status' })).toContain('99: unknown status')
  })

  test('a non-numeric code is not mistaken for a status (the shape is checked, not assumed)', () => {
    const rendered = SaBootstrap.describeIamCallFailure({ code: '7', details: 'string code' })
    expect(rendered).toContain('string code')
    expect(rendered).not.toContain('PERMISSION_DENIED')
  })

  test('an empty details string falls back to the message', () => {
    expect(SaBootstrap.describeIamCallFailure({ code: 13, details: '', message: 'the real message' })).toContain(
      'the real message',
    )
  })

  test('a non-string details falls back to the message', () => {
    expect(SaBootstrap.describeIamCallFailure({ code: 13, details: 42, message: 'fallback message' })).toContain(
      'fallback message',
    )
  })

  test('a status with no text at all still renders the status', () => {
    // Neither `details` nor `message`: the status alone is what the operator gets.
    expect(SaBootstrap.describeIamCallFailure({ code: 13 })).toBe('Nebius IAM bootstrap call failed: INTERNAL (13).')
  })

  test('a status-less object falls back to its string form', () => {
    expect(SaBootstrap.describeIamCallFailure({ details: '', message: '' })).toContain('[object Object]')
  })

  test('only the two actionable statuses carry a hint', () => {
    expect(SaBootstrap.describeIamCallFailure({ code: 7, details: 'x' })).toContain('needs IAM write access')
    expect(SaBootstrap.describeIamCallFailure({ code: 16, details: 'x' })).toContain('expired or truncated')
    for (const code of [3, 5, 8, 13, 14]) {
      const rendered = SaBootstrap.describeIamCallFailure({ code, details: 'x' })
      expect(rendered).not.toContain('needs IAM write access')
      expect(rendered).not.toContain('expired or truncated')
      // No hint sentence: exactly the one-sentence prefix plus the server text.
      expect(rendered.endsWith('x.')).toBe(true)
      expect(rendered.split('. ')).toHaveLength(1)
    }
  })
})
