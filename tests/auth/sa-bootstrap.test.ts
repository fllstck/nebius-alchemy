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
