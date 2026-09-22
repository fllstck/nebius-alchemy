import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/iam/v1/access-permit.ts'
import * as SchemaModule from '../../../../modules/resources/iam/v1/access-permit.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'
import { mockIamLayer, stackLayer, fakeSession, protoMetadata } from '../../../helpers/mocks.ts'

const { describe, expect, test } = BunTest

/**
 * AccessPermit is a NON-STANDARD API: the parent is a GROUP (not a project),
 * the resource's own name is ignored (auto-generated), and the identity is
 * (parentId, resourceId, role).
 */

const permitProto = (id: string, name: string, parentId: string, resourceId: string, role: string, labels: Record<string, string> = {}) => ({
  metadata: protoMetadata(id, name, parentId, labels),
  spec: { resourceId, role },
  status: {},
})

describe('Nebius.iam.v1.AccessPermit', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusAccessPermit).toBeDefined()
    expect(typeof Module.NebiusAccessPermit).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusAccessPermitProvider).toBeDefined()
  })

  describe('diff', () => {
    const base = { parentId: 'group-abc123', resourceId: 'resource-1', role: 'editor' }

    const diff = async (news: unknown, olds: unknown = base) => {
      const svc = await resolveProvider(Module.NebiusAccessPermit.Provider, Module.NebiusAccessPermitProvider)
      return runDiff(svc, news, olds)
    }

    // No Update RPC: every spec field must plan a replace, or the change is
    // silently lost. Delete-first, because a permit sends no `metadata.name`
    // (the API rejects it) — the grant's identity is server-side `(group,
    // resource)`, which a create-first replacement would collide with.
    test('role change replaces the permit (delete-first)', async () => {
      expect(await diff({ ...base, role: 'viewer' })).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('resourceId change replaces the permit (delete-first)', async () => {
      expect(await diff({ ...base, resourceId: 'resource-2' })).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('labels-only change is a noop (declared exception)', async () => {
      expect(await diff({ ...base, labels: { a: '1' } }, { ...base, labels: { a: '2' } })).toBeUndefined()
    })

    test('parentId change requires replace but NOT delete-first (a different group)', async () => {
      expect(await diff({ ...base, parentId: 'group-abc999' })).toEqual({ action: 'replace' })
    })
  })

  describe('group-parent requirements', () => {
    test('requires a group parentId (rejects props without it)', async () => {
      const result = await runEffect(
        SchemaModule.validateAccessPermitProps({ resourceId: 'resource-1', role: 'editor' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('dedup list is scoped to the group parent id', async () => {
      const svc = await resolveProvider(Module.NebiusAccessPermit.Provider, Module.NebiusAccessPermitProvider)

      const listCalls: string[] = []
      const layer = mockIamLayer({
        accessPermit: {
          get: () => Effect.fail({ _tag: 'GrpcError', code: 5 }),
          list: (parentId: string) => {
            listCalls.push(parentId)
            return Effect.succeed([])
          },
          create: (req: { metadata: { name: string; parentId: string } }) =>
            Effect.succeed(permitProto('permit-new', req.metadata.name, req.metadata.parentId, 'resource-1', 'editor')),
          delete: () => Effect.void,
        },
      })

      await runEffect(
        svc.reconcile({
          id: 'ap_test',
          fqn: 'ap_test',
          instanceId: 'inst',
          news: { parentId: 'group-1', resourceId: 'resource-1', role: 'editor' },
          output: undefined,
          session: fakeSession,
        } as any).pipe(Effect.provide(layer), Effect.provide(stackLayer)),
      )

      // The permit is looked up within the GROUP — never a project.
      expect(listCalls).toEqual(['group-1'])
    })
  })

  describe('reconcile', () => {
    test('reuses an existing permit with the same (parentId, resourceId, role) — create not called', async () => {
      const svc = await resolveProvider(Module.NebiusAccessPermit.Provider, Module.NebiusAccessPermitProvider)

      let createCalled = false
      const layer = mockIamLayer({
        accessPermit: {
          get: () => Effect.fail({ _tag: 'GrpcError', code: 5 }),
          list: () => Effect.succeed([permitProto('permit-1', 'ap-existing', 'group-1', 'resource-1', 'editor', { 'alchemy::id': 'ap_test' })]),
          create: () => {
            createCalled = true
            return Effect.never
          },
          delete: () => Effect.void,
        },
      })

      const output = await runEffect(
        svc.reconcile({
          id: 'ap_test',
          fqn: 'ap_test',
          instanceId: 'inst',
          news: { parentId: 'group-1', resourceId: 'resource-1', role: 'editor' },
          output: undefined,
          session: fakeSession,
        } as any).pipe(Effect.provide(layer)),
      )

      expect(output).toMatchObject({ id: 'permit-1', resourceId: 'resource-1', role: 'editor' })
      expect(createCalled).toBe(false)
    })

    test('create omits metadata.name — the API rejects it (verified live)', async () => {
      const svc = await resolveProvider(Module.NebiusAccessPermit.Provider, Module.NebiusAccessPermitProvider)

      const createCalls: Array<{ metadata: { name: string; parentId: string } }> = []
      const layer = mockIamLayer({
        accessPermit: {
          get: () => Effect.fail({ _tag: 'GrpcError', code: 5 }),
          list: () => Effect.succeed([]),
          create: (req: { metadata: { name: string; parentId: string } }) => {
            createCalls.push(req)
            return Effect.succeed(permitProto('permit-new', req.metadata.name, req.metadata.parentId, 'resource-1', 'editor'))
          },
          delete: () => Effect.void,
        },
      })

      await runEffect(
        svc.reconcile({
          id: 'ap_test',
          fqn: 'ap_test',
          instanceId: 'inst',
          news: { parentId: 'group-1', resourceId: 'resource-1', role: 'editor' },
          output: undefined,
          session: fakeSession,
        } as any).pipe(Effect.provide(layer), Effect.provide(stackLayer)),
      )

      expect(createCalls).toHaveLength(1)
      // The API rejects metadata.name on AccessPermit creates (same rule as
      // GroupMembership) and the prop no longer exists — the request must carry
      // no name at all; `ap-<logicalId>` is a local label only.
      expect(createCalls[0]!.metadata.name).toBeUndefined()
      expect(createCalls[0]!.metadata.parentId).toBe('group-1')
    })
  })
})
