import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/federated-credentials'
import * as SchemaModule from '../../../../modules/resources/iam/v1/federated-credentials.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'

const { describe, expect, test } = BunTest

const validFedCredsProps = {
  name: 'my-fed-creds',
  oidcProvider: { issuerUrl: 'https://issuer.example.com' },
  federatedSubjectId: 'sub-123',
  subjectId: 'serviceaccount-abc123' as SchemaModule.FederatedCredentialsProps['subjectId'],
}

describe('Nebius.iam.v1.FederatedCredentials', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusFederatedCredentials).toBeDefined()
    expect(typeof Module.NebiusFederatedCredentials).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusFederatedCredentialsProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusFederatedCredentials.Provider, Module.NebiusFederatedCredentialsProvider)
      expect(await runDiff(svc, { name: 'new-creds' }, { name: 'old-creds' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusFederatedCredentials.Provider, Module.NebiusFederatedCredentialsProvider)
      expect(await runDiff(svc, { name: 'my-creds' }, { name: 'my-creds' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SchemaModule.validateFederatedCredentialsProps(validFedCredsProps))
      expect(result.federatedSubjectId).toBe('sub-123')
      expect(result.subjectId).toBe('serviceaccount-abc123')
    })

    test('rejects a missing federatedSubjectId', async () => {
      const result = await runEffect(
        SchemaModule.validateFederatedCredentialsProps({
          ...validFedCredsProps,
          federatedSubjectId: undefined,
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
