import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/group-membership.ts'
import * as SchemaModule from '../../../../modules/resources/iam/v1/group-membership.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'
import { mockIamLayer, stackLayer, fakeSession, protoMetadata } from '../../../helpers/mocks.ts'

const { describe, expect, test } = BunTest

/**
 * GroupMembership is a NON-STANDARD API: enumeration uses `listMembers`
 * (there is no `list`), the parent is a GROUP, and membership identity is
 * (parentId, memberId).
 */

const membershipProto = (
  id: string,
  name: string,
  parentId: string,
  memberId: string,
  labels: Record<string, string> = {},
  // `revokeAt` is a TOP-LEVEL field of the resource (not in `status`).
  revokeAt?: Date,
) => ({
  metadata: protoMetadata(id, name, parentId, labels),
  spec: { memberId },
  status: {},
  revokeAt,
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
    const base = { parentId: 'group-1', memberId: 'member-1' }

    const diff = async (news: unknown, olds: unknown = base) => {
      const svc = await resolveProvider(Module.NebiusGroupMembership.Provider, Module.NebiusGroupMembershipProvider)
      return runDiff(svc, news, olds)
    }

    // The service has NO Update RPC, so `revokeAfterHours` is create-only: it must
    // plan a replace or the change is silently lost. Delete-first, because the same
    // (parentId, memberId) pair cannot exist twice and memberships send no
    // `metadata.name` to distinguish two generations.
    test('revokeAfterHours change replaces the membership (delete-first)', async () => {
      expect(await diff({ ...base, revokeAfterHours: 24 })).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('a falsy revokeAfterHours is not a change (the create only sends it when truthy)', async () => {
      expect(await diff({ ...base, revokeAfterHours: 0 })).toBeUndefined()
    })

    // The live case caught this: a *truthiness* comparison plans nothing for
    // 24 → 48 (both truthy), so the change was silently lost — the very bug this
    // check exists to prevent. Only the falsy case may be normalised away.
    test('revokeAfterHours 24 → 48 replaces (a truthiness comparison would miss it)', async () => {
      expect(await diff({ ...base, revokeAfterHours: 48 }, { ...base, revokeAfterHours: 24 })).toEqual({
        action: 'replace',
        deleteFirst: true,
      })
    })

    test('labels-only change is a noop (declared exception)', async () => {
      expect(await diff({ ...base, labels: { a: '1' } }, { ...base, labels: { a: '2' } })).toBeUndefined()
    })

    test('memberId change requires replace (a different membership — create-first is safe)', async () => {
      expect(await diff({ ...base, memberId: 'member-2' })).toEqual({ action: 'replace' })
    })

    test("parentId change requires replace (a membership can't move groups)", async () => {
      expect(await diff({ ...base, parentId: 'group-2' })).toEqual({ action: 'replace' })
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

    test('surfaces top-level `revokeAt` as an attribute (it is not in `status`)', async () => {
      const svc = await resolveProvider(Module.NebiusGroupMembership.Provider, Module.NebiusGroupMembershipProvider)

      const revokeAt = new Date('2026-10-01T00:00:00.000Z')
      const layer = mockIamLayer({
        groupMembership: {
          get: () => Effect.fail({ _tag: 'GrpcError', code: 5 }),
          listMembers: () =>
            Effect.succeed([
              membershipProto('gm-1', 'gm-existing', 'group-1', 'member-1', { 'alchemy::id': 'gm_test' }, revokeAt),
            ]),
          create: () => Effect.never,
          delete: () => Effect.void,
        },
      })

      const output = await runEffect(
        svc.reconcile({
          id: 'gm_test',
          fqn: 'gm_test',
          instanceId: 'inst',
          news: { parentId: 'group-1', memberId: 'member-1', revokeAfterHours: 24 },
          output: undefined,
          session: fakeSession,
        } as any).pipe(Effect.provide(layer)),
      )

      // `toFriendlyAttributes` spreads metadata/spec/status only, so this needs
      // the explicit override — without it the attribute was always undefined,
      // hiding the one observable of `revokeAfterHours`.
      expect(output.revokeAt).toEqual(revokeAt)
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
