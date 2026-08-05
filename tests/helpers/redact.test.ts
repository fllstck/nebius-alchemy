import { describe, expect, test } from 'bun:test'
import { redact } from './cleanup'

describe('redact', () => {
  test('masks api keys in key=value form', () => {
    expect(redact('apiKey=AKIAIOSFODNN7EXAMPLE')).toBe('apiKey=<redacted>')
  })

  test('masks access key ids in key: value form', () => {
    expect(redact('access_key: AKIAIOSFODNN7EXAMPLE rest of message')).toBe(
      'access_key: <redacted> rest of message',
    )
  })

  test('masks secret access keys (AWS/Nebius naming)', () => {
    expect(redact('secretAccessKey=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(
      'secretAccessKey=<redacted>',
    )
  })

  test('masks JSON-style quoted values', () => {
    expect(redact('"secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"')).toBe(
      '"secretAccessKey": "<redacted>"',
    )
  })

  test('masks bearer tokens', () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(redact(`Authorization: Bearer ${token}`)).toBe('Authorization: Bearer <redacted>')
  })

  test('masks key material inside gRPC details payloads', () => {
    const input =
      'GrpcError: code = 7 desc = permission denied, details: "accessKeyId=AKIAIOSFODNN7EXAMPLE apiKey=abc123"'
    const out = redact(input)
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).not.toContain('abc123')
  })

  test('masks standalone secret= values', () => {
    expect(redact('secret=super-secret-value in error text')).toBe(
      'secret=<redacted> in error text',
    )
  })

  test('non-sensitive error strings pass through unchanged', () => {
    const msg =
      'GrpcError: connect ECONNREFUSED 0.0.0.0:443, rpc error: code = Unavailable desc = connection refused to storage.eu-north1.nebius.cloud'
    expect(redact(msg)).toBe(msg)
  })

  test('empty input stays empty', () => {
    expect(redact('')).toBe('')
  })
})
