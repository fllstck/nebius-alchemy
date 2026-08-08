import { describe, expect, test } from 'bun:test'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import * as SaToken from '../../modules/auth/sa-token.ts'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const testKey: SaToken.SaKey = {
  serviceAccountId: 'serviceaccount-abc123',
  keyId: 'akey-xyz789',
  privateKey: privateKeyPem,
}

const decodePart = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>

describe('SaToken.signJwt', () => {
  test('produces a structurally valid JWT (3 dot-separated base64url parts)', () => {
    const jwt = SaToken.signJwt(testKey)
    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)
    for (const part of parts) {
      expect(Buffer.from(part, 'base64url').toString()).not.toBe('')
    }
  })

  test('header carries alg RS256 and the authorized key id (kid)', () => {
    const header = decodePart(SaToken.signJwt(testKey).split('.')[0]!)
    expect(header.alg).toBe('RS256')
    expect(header.typ).toBe('JWT')
    expect(header.kid).toBe('akey-xyz789')
  })

  test('claims carry iss/sub = service account id and a 5-minute lifetime', () => {
    const nowMs = 1_700_000_000_000
    const payload = decodePart(SaToken.signJwt(testKey, nowMs).split('.')[1]!)
    expect(payload.iss).toBe('serviceaccount-abc123')
    expect(payload.sub).toBe('serviceaccount-abc123')
    expect(payload.iat).toBe(nowMs / 1000)
    expect(payload.exp).toBe(nowMs / 1000 + SaToken.JWT_TTL_SECONDS)
    expect(payload.exp).toBeGreaterThan(payload.iat as number)
  })

  test('signature verifies against the public key (RS256)', () => {
    const jwt = SaToken.signJwt(testKey)
    const [h, p, s] = jwt.split('.') as [string, string, string]
    const publicKey = createPublicKey(privateKeyPem)
    const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))
    expect(ok).toBe(true)
  })

  test('different private keys produce different signatures for identical claims', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const a = SaToken.signJwt(testKey)
    const b = SaToken.signJwt({ ...testKey, privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })
    expect(a).not.toBe(b)
  })
})

describe('SaToken.buildExchangeRequest', () => {
  test('sets the RFC 8693 grant type and JWT subject token', () => {
    const req = SaToken.buildExchangeRequest('the-jwt')
    expect(req.grantType).toBe('urn:ietf:params:oauth:grant-type:token-exchange')
    expect(req.subjectToken).toBe('the-jwt')
    expect(req.subjectTokenType).toBe('urn:ietf:params:oauth:token-type:jwt')
    // Optional fields stay unset — the endpoint defaults the requested type.
    expect(req.requestedTokenType).toBe('')
  })
})

describe('SaToken constants', () => {
  test('token endpoint is the dedicated unauthenticated tokens service', () => {
    expect(SaToken.TOKEN_EXCHANGE_ENDPOINT).toBe('tokens.iam.api.nebius.cloud:443')
  })
})
