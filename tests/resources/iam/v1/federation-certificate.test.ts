import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/federation-certificate.ts'
import * as SchemaModule from '../../../../modules/resources/iam/v1/federation-certificate.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

const PEM_DATA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'

describe('Nebius.iam.v1.FederationCertificate', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusFederationCertificate).toBeDefined()
    expect(typeof Module.NebiusFederationCertificate).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusFederationCertificateProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusFederationCertificate.Provider, Module.NebiusFederationCertificateProvider)
      expect(await runDiff(svc, { parentId: 'federation-abc123', name: 'new-cert', data: PEM_DATA }, { parentId: 'federation-abc123', name: 'old-cert', data: PEM_DATA })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusFederationCertificate.Provider, Module.NebiusFederationCertificateProvider)
      expect(await runDiff(svc, { parentId: 'federation-abc123', name: 'my-cert', data: PEM_DATA }, { parentId: 'federation-abc123', name: 'my-cert', data: PEM_DATA })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid PEM props', async () => {
      const result = await runEffect(
        SchemaModule.validateFederationCertificateProps({ parentId: 'fed-abc123', data: PEM_DATA }),
      )
      expect(result.data).toBe(PEM_DATA)
    })

    test('rejects non-PEM certificate data', async () => {
      const result = await runEffect(
        SchemaModule.validateFederationCertificateProps({ parentId: 'fed-abc123', data: 'not a cert' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
