import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/federation.ts'
import * as SchemaModule from '../../../../modules/resources/iam/v1/federation.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

const validFederationProps = {
  name: 'my-federation',
  samlSettings: {
    idpIssuer: 'https://idp.example.com',
    ssoUrl: 'https://idp.example.com/sso',
  },
}

describe('Nebius.iam.v1.Federation', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusFederation).toBeDefined()
    expect(typeof Module.NebiusFederation).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusFederationProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusFederation.Provider, Module.NebiusFederationProvider)
      expect(await runDiff(svc, { name: 'new-federation' }, { name: 'old-federation' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusFederation.Provider, Module.NebiusFederationProvider)
      expect(await runDiff(svc, { name: 'my-federation' }, { name: 'my-federation' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SchemaModule.validateFederationProps(validFederationProps))
      expect(result.name).toBe('my-federation')
    })

    test('rejects an invalid idpIssuer URL', async () => {
      const result = await runEffect(
        SchemaModule.validateFederationProps({
          ...validFederationProps,
          samlSettings: { idpIssuer: 'not-a-url', ssoUrl: 'https://idp.example.com/sso' },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
