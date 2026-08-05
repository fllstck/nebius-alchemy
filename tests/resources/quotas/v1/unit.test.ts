import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as QuotaAllowanceModule from '../../../../modules/resources/quotas/v1/quota-allowance'
import * as SchemaModule from '../../../../modules/resources/quotas/v1/quota-allowance.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'
import { mockQuotasLayer, testConfigLayer, fakeSession, protoMetadata, ZERO_LONG } from '../../../helpers/mocks'

const { describe, expect, test } = BunTest

/** Proto QuotaAllowance fixture. */
const quotaProto = (id: string, name: string, parentId: string, region: string) => ({
  metadata: protoMetadata(id, name, parentId),
  spec: { region, limit: undefined },
  status: { state: 0, usage: ZERO_LONG },
})

describe('Nebius.quotas.v1.QuotaAllowance', () => {
  test('NebiusQuotaAllowance resource constructor is defined', () => {
    expect(QuotaAllowanceModule.NebiusQuotaAllowance).toBeDefined()
    expect(typeof QuotaAllowanceModule.NebiusQuotaAllowance).toBe('function')
  })

  test('NebiusQuotaAllowanceProvider is defined', () => {
    expect(QuotaAllowanceModule.NebiusQuotaAllowanceProvider).toBeDefined()
  })

  describe('diff — identity is (name, region), not id', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(QuotaAllowanceModule.NebiusQuotaAllowance.Provider, QuotaAllowanceModule.NebiusQuotaAllowanceProvider)
      expect(await runDiff(svc, { name: 'quota-b', region: 'eu-west1' }, { name: 'quota-a', region: 'eu-west1' })).toEqual({ action: 'replace' })
    })

    test('region change requires replace', async () => {
      const svc = await resolveProvider(QuotaAllowanceModule.NebiusQuotaAllowance.Provider, QuotaAllowanceModule.NebiusQuotaAllowanceProvider)
      expect(await runDiff(svc, { name: 'quota-a', region: 'eu-north1' }, { name: 'quota-a', region: 'eu-west1' })).toEqual({ action: 'replace' })
    })

    test('limit-only change is NOT a replace (in-place update)', async () => {
      const svc = await resolveProvider(QuotaAllowanceModule.NebiusQuotaAllowance.Provider, QuotaAllowanceModule.NebiusQuotaAllowanceProvider)
      expect(await runDiff(svc, { name: 'quota-a', region: 'eu-west1', limit: '100' }, { name: 'quota-a', region: 'eu-west1', limit: '50' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateQuotaAllowanceProps({ name: 'compute.disk.size.network-ssd', region: 'eu-west1' }),
      )
      expect(result.name).toBe('compute.disk.size.network-ssd')
    })

    test('rejects an unknown region', async () => {
      const result = await runEffect(
        SchemaModule.validateQuotaAllowanceProps({ name: 'compute.disk.size', region: 'mars-1' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })

  describe('reconcile — identity is (parentId, name, region), not id', () => {
    test('looks up by (parentId, name, region) via getByName, never by id alone', async () => {
      const svc = await resolveProvider(QuotaAllowanceModule.NebiusQuotaAllowance.Provider, QuotaAllowanceModule.NebiusQuotaAllowanceProvider)

      let createCalled = false
      const getByNameCalls: Array<{ parentId: string; name: string; region: string }> = []
      const layer = mockQuotasLayer({
        quotaAllowance: {
          get: () => Effect.fail({ _tag: 'GrpcError', code: 5 }),
          getByName: (req: { parentId: string; name: string; region: string }) => {
            getByNameCalls.push(req)
            return Effect.succeed(quotaProto('qa-1', req.name, req.parentId, req.region))
          },
          list: () => Effect.succeed([]),
          create: () => {
            createCalled = true
            return Effect.never
          },
          update: () => Effect.never,
          delete: () => Effect.void,
        },
      })

      const output = await runEffect(
        svc.reconcile({
          id: 'qa_test',
          fqn: 'qa_test',
          instanceId: 'inst',
          news: { name: 'compute.disk.size', region: 'eu-west1' },
          output: undefined,
          session: fakeSession,
        } as any).pipe(Effect.provide(layer), Effect.provide(testConfigLayer)),
      )

      // parentId falls back to NEBIUS_PROJECT_ID; the identity tuple is exact.
      expect(getByNameCalls).toEqual([{ parentId: 'project-test-1', name: 'compute.disk.size', region: 'eu-west1' }])
      expect(output).toMatchObject({ id: 'qa-1', name: 'compute.disk.size', region: 'eu-west1' })
      expect(createCalled).toBe(false)
    })

    test('creates with the (parentId, name, region) tuple when getByName is NOT_FOUND', async () => {
      const svc = await resolveProvider(QuotaAllowanceModule.NebiusQuotaAllowance.Provider, QuotaAllowanceModule.NebiusQuotaAllowanceProvider)

      const createCalls: Array<{ metadata: { parentId: string; name: string }; spec: { region: string } }> = []
      const layer = mockQuotasLayer({
        quotaAllowance: {
          get: () => Effect.fail({ _tag: 'GrpcError', code: 5 }),
          getByName: () => Effect.fail({ _tag: 'GrpcError', code: 5, message: 'not found' }),
          list: () => Effect.succeed([]),
          create: (req: { metadata: { parentId?: string; name?: string }; spec: { region: string } }) => {
            createCalls.push(req as { metadata: { parentId: string; name: string }; spec: { region: string } })
            return Effect.succeed(quotaProto('qa-new', req.metadata.name!, req.metadata.parentId!, req.spec.region))
          },
          update: () => Effect.never,
          delete: () => Effect.void,
        },
      })

      const output = await runEffect(
        svc.reconcile({
          id: 'qa_test',
          fqn: 'qa_test',
          instanceId: 'inst',
          news: { name: 'compute.disk.size', region: 'eu-west1' },
          output: undefined,
          session: fakeSession,
        } as any).pipe(Effect.provide(layer), Effect.provide(testConfigLayer)),
      )

      expect(createCalls).toHaveLength(1)
      expect(createCalls[0]!.metadata.parentId).toBe('project-test-1')
      expect(createCalls[0]!.metadata.name).toBe('compute.disk.size')
      expect(createCalls[0]!.spec.region).toBe('eu-west1')
      expect(output).toMatchObject({ id: 'qa-new', region: 'eu-west1' })
    })
  })
})
