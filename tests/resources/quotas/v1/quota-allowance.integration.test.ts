import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import * as Config from 'effect/Config'
import * as QuotasGrpc from '../../../../modules/api-client/quotas'
import * as IamGrpc from '../../../../modules/api-client/iam'
import * as NebiusQuotaAllowanceSchema from '../../../../schemas/nebius/quotas/v1/quota_allowance'
import * as ResourceUtils from '../../../../modules/resources/utilities.ts'
import * as QuotaAllowanceSchema from '../../../../modules/resources/quotas/v1/quota-allowance.schema.ts'
import { makeTenantScopedList } from '../../../../modules/resources/factory.ts'
import { integrationTest } from '../../../helpers/gate'

const { test } = Test.make({ providers: Nebius.providers() as any })

const toFriendlyAttributes = (
  raw: NebiusQuotaAllowanceSchema.QuotaAllowance,
): QuotaAllowanceSchema.QuotaAllowanceAttributes =>
  ResourceUtils.toFriendlyAttributes<QuotaAllowanceSchema.QuotaAllowanceAttributes>({
    rawResource: raw,
    resourceSchema: NebiusQuotaAllowanceSchema.QuotaAllowance,
  })

integrationTest(
  test.provider,
  'Nebius.quotas.v1.QuotaAllowance list (raw gRPC)',
  (_stack) =>
    Effect.gen(function* () {
      // Quota allowances are pre-provisioned by Nebius — test the list endpoint directly
      const parentId = yield* Config.string('NEBIUS_PROJECT_ID')
      const items = yield* Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* QuotasGrpc.QuotasGrpcService
          return yield* svc.quotaAllowance.list(parentId)
        }),
      )

      expect(Array.isArray(items)).toBe(true)
      if (items.length > 0) {
        const first = items[0]!
        expect(first.metadata).toBeDefined()
        expect(first.status).toBeDefined()
        expect(first.status?.service).toBeDefined()
      }
    }),
  { timeout: 30_000 },
)

integrationTest(
  test.provider,
  'Nebius.quotas.v1.QuotaAllowance list filters virtual defaults',
  (_stack) =>
    Effect.gen(function* () {
      const tenantId = yield* Config.string('NEBIUS_TENANT_ID')
      const iam = yield* IamGrpc.IamGrpcService
      const quotas = yield* QuotasGrpc.QuotasGrpcService

      // Collect projects and raw QAs per project
      const projects = yield* iam.project.list(tenantId)
      const allRaw: Array<{ name: string; hasId: boolean; epochCreated: boolean }> = []
      for (const p of projects) {
        const items = yield* quotas.quotaAllowance.list(p.metadata!.id)
        for (const item of items) {
          allRaw.push({
            name: item.metadata?.name ?? '',
            hasId: item.metadata?.id !== undefined,
            epochCreated: item.metadata?.createdAt?.getTime() === 0,
          })
        }
      }

      // Collect QAs with Alchemy labels (the ones that should survive filtering)
      const alchemyLabeled: Array<{ name: string }> = []
      for (const p of projects) {
        const items = yield* quotas.quotaAllowance.list(p.metadata!.id)
        for (const item of items) {
          if (item.metadata?.labels && Object.keys(item.metadata.labels).some((k) => k.startsWith('alchemy::'))) {
            alchemyLabeled.push({ name: item.metadata.name ?? '' })
          }
        }
      }

      // Reconstruct the same tenant-scoped list the provider uses (with isDefaultResource)
      const tenantScopedList = makeTenantScopedList({
        resourceName: 'Nebius.quotas.v1.QuotaAllowance',
        service: QuotasGrpc.QuotasGrpcService,
        iamService: IamGrpc.IamGrpcService,
        projectList: (iam, tenantId) => iam.project.list(tenantId),
        projectId: (p) => p.metadata!.id,
        listByParent: (svc, parentId) => svc.quotaAllowance.list(parentId),
        toAttrs: (raw) => toFriendlyAttributes(raw),
      })

      const result = yield* tenantScopedList()

      console.log(`\n  Total raw QAs (all projects): ${allRaw.length}`)
      console.log(`  QAs with alchemy labels: ${alchemyLabeled.length}`)
      console.log(`  System defaults (no labels): ${allRaw.length - alchemyLabeled.length}`)
      console.log(`  Provider list returned: ${result.length}`)

      // Only Alchemy-labeled QAs should survive the filter
      expect(result.length).toBe(alchemyLabeled.length)
    }),
  { timeout: 60_000 },
)
