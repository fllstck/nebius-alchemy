import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/group-membership'
import * as SchemaModule from '../../../../modules/resources/iam/v1/group-membership.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'
import { mockIamLayer, stackLayer, fakeSession, protoMetadata } from '../../../helpers/mocks'

const { describe, expect, test } = BunTest

/**
 * GroupMembership is a NON-STANDARD API: enumeration uses `listMembers`
 * (there is no `list`), the parent is a GROUP, and membership identity is
 * (parentId, memberId).
 */

const membershipProto = (id: string, name: string, parentId: string, memberId: string, labels: Record<string, string> = {}) => ({
  metadata: protoMetadata(id, name, parentId, labels),
  spec: { memberId },
  status: {},
})

describe('Nebius.iam.v1.GroupMembership', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusGroupMembership).toBeDefined()
    expect(typeof Module.NebiusGroupMembership).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusGroupMembershipProvider).toBeDefined()
  })

  describe('diff', () => {
    test('memberId change requires replace (immutable)', async () => {
      const svc = await resolveProvider(Module.NebiusGroupMembership.Provider, Module.NebiusGroupMembershipProvider)
      expect(await runDiff(svc, { memberId: 'member-2' }, { memberId: 'member-1' })).toEqual({ action: 'replace' })
    })
    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusGroupMembership.Provider, Module.NebiusGroupMembershipProvider)
      expect(await runDiff(svc, { memberId: 'member-1' }, { memberId: 'member-1' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('requires a group parentId', async () => {
      const result = await runEffect(
        SchemaModule.validateGroupMembershipProps({ memberId: 'member-1' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateGroupMembershipProps({ parentId: 'group-1', memberId: 'member-1' }),
      )
      expect(result.memberId).toBe('member-1')
    })
  })

  describe('reconcile — listMembers, not list', () => {
    test('dedup uses listMembers on a mock with NO list method', async () => {
      const svc = await resolveProvider(Module.NebiusGroupMembership.Provider, Module.NebiusGroupMembershipProvider)

      let createCalled = false
      // Deliberately omits `list` — if the provider called it, this throws.
      const layer = mockIamLayer({
        groupMembership: {
          get: () => Effect.fail({ _tag: 'GrpcError', code: 5 }),
          listMembers: () =>
            Effect.succeed([
              membershipProto('gm-1', 'gm-existing', 'group-1', 'member-1', { 'alchemy::id': 'gm_test' }),
            ]),
          create: () => {
            createCalled = true
            return Effect.never
          },
          delete: () => Effect.void,
        },
      })

      const output = await runEffect(
        svc.reconcile({
          id: 'gm_test',
          fqn: 'gm_test',
          instanceId: 'inst',
          news: { parentId: 'group-1', memberId: 'member-1' },
          output: undefined,
          session: fakeSession,
        } as any).pipe(Effect.provide(layer)),
      )

      expect(output).toMatchObject({ id: 'gm-1', memberId: 'member-1' })
      expect(createCalled).toBe(false)
    })

    test('create sends parentId + alchemy labels and NO metadata.name (API prohibits it)', async () => {
      const svc = await resolveProvider(Module.NebiusGroupMembership.Provider, Module.NebiusGroupMembershipProvider)

      const createCalls: Array<{ metadata: { name?: string; parentId: string; labels?: Record<string, string> } }> = []
      const layer = mockIamLayer({
        groupMembership: {
          get: () => Effect.fail({ _tag: 'GrpcError', code: 5 }),
          listMembers: () => Effect.succeed([]),
          create: (req: { metadata: { name?: string; parentId: string; labels?: Record<string, string> } }) => {
            createCalls.push(req)
            return Effect.succeed(membershipProto('gm-new', req.metadata.name ?? '', req.metadata.parentId, 'member-1'))
          },
          delete: () => Effect.void,
        },
      })

      await runEffect(
        svc.reconcile({
          id: 'gm_test',
          fqn: 'gm_test',
          instanceId: 'inst',
          news: { parentId: 'group-1', memberId: 'member-1' },
          output: undefined,
          session: fakeSession,
        // oxlint-disable-next-line no-explicit-any — reconcile input mock
        } as any).pipe(Effect.provide(layer), Effect.provide(stackLayer)),
      )

      expect(createCalls).toHaveLength(1)
      // Nebius IAM rejects metadata.name on group-membership creates — the
      // provider must NOT send it.
      expect(createCalls[0]!.metadata.name).toBeUndefined()
      expect(createCalls[0]!.metadata.parentId).toBe('group-1')
      expect(createCalls[0]!.metadata.labels?.['alchemy::id']).toBe('gm_test')
    })
  })
})
