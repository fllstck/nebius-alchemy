import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/invitation'
import * as SchemaModule from '../../../../modules/resources/iam/v1/invitation.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.Invitation', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusInvitation).toBeDefined()
    expect(typeof Module.NebiusInvitation).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusInvitationProvider).toBeDefined()
  })

  describe('diff', () => {
    test('email change requires replace (immutable)', async () => {
      const svc = await resolveProvider(Module.NebiusInvitation.Provider, Module.NebiusInvitationProvider)
      expect(await runDiff(svc, { email: 'b@example.com' }, { email: 'a@example.com' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusInvitation.Provider, Module.NebiusInvitationProvider)
      expect(await runDiff(svc, { email: 'a@example.com' }, { email: 'a@example.com' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateInvitationProps({ email: 'user@example.com' }),
      )
      expect(result.email).toBe('user@example.com')
    })

    test('rejects malformed email', async () => {
      const result = await runEffect(
        SchemaModule.validateInvitationProps({ email: 'not-an-email' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
