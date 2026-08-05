import { describe, expect, test } from 'bun:test'
import * as Schema from 'effect/Schema'
import * as HostIdentityModule from '../../../modules/resources/shared/host-identity'

const ENCODED_IDENTITY = {
  serviceAccountId: 'serviceaccount-abc123',
  groupId: 'group-xyz789',
  awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 's3cr3t',
}

describe('host-identity', () => {
  test('HostIdentity schema class is defined', () => {
    expect(HostIdentityModule.HostIdentity).toBeDefined()
  })

  test('hostIdentity provisioning fn is defined', () => {
    expect(typeof HostIdentityModule.hostIdentity).toBe('function')
  })

  describe('HostIdentity schema', () => {
    test('decodes a plain object identity', () => {
      const decoded = Schema.decodeUnknownSync(HostIdentityModule.HostIdentity)(ENCODED_IDENTITY)
      expect(decoded.serviceAccountId).toBe('serviceaccount-abc123')
      expect(decoded.groupId).toBe('group-xyz789')
      expect(decoded.awsAccessKeyId).toBe('AKIAIOSFODNN7EXAMPLE')
      expect(decoded.secretAccessKey).toBe('s3cr3t')
    })

    test('rejects a malformed identity (non-string secret)', () => {
      expect(() =>
        Schema.decodeUnknownSync(HostIdentityModule.HostIdentity)({
          ...ENCODED_IDENTITY,
          secretAccessKey: 123,
        }),
      ).toThrow()
    })
  })
})
