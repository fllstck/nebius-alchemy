import { describe, expect, test } from 'bun:test'
import * as Output from 'alchemy/Output'
import * as HostIdentityModule from '../../../modules/resources/shared/host-identity.ts'

describe('host-identity', () => {
  test('hostIdentity provisioning fn is defined', () => {
    expect(typeof HostIdentityModule.hostIdentity).toBe('function')
  })

  test('grantBucketAccess fn is defined', () => {
    expect(typeof HostIdentityModule.grantBucketAccess).toBe('function')
  })

  describe('HostIdentity shape', () => {
    // The identity carries the lazily-declared resources' OUTPUT expressions,
    // not resolved strings: resolving them inline (`yield* yield* sa.id`)
    // hangs/returns undefined inside a binding impl (the ambient
    // RuntimeContext during a resource lifecycle is not the resolve context).
    // alchemy resolves the Outputs where they're consumed — Input props and
    // binding data run through `Output.evaluate` at apply time.
    test('fields are Output expressions (deferred resolution)', () => {
      const identity: HostIdentityModule.HostIdentity = {
        serviceAccountId: Output.literal('serviceaccount-abc123' as never),
        groupId: Output.literal('group-xyz789' as never),
        awsAccessKeyId: Output.literal('AKIAIOSFODNN7EXAMPLE'),
        secretAccessKey: Output.literal('s3cr3t'),
      }
      expect(Output.isOutput(identity.serviceAccountId)).toBe(true)
      expect(Output.isOutput(identity.groupId)).toBe(true)
      expect(Output.isOutput(identity.awsAccessKeyId)).toBe(true)
      expect(Output.isOutput(identity.secretAccessKey)).toBe(true)
    })
  })
})
