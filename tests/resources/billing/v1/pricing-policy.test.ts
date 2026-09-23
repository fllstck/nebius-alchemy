import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import * as Module from '../../../../modules/resources/billing/v1/pricing-policy.ts'
import * as SchemaModule from '../../../../modules/resources/billing/v1/pricing-policy.schema.ts'
import * as NebiusPricingPolicySchema from '../../../../schemas/nebius/billing/v1/pricing_policy.ts'
import {
  instanceIdLayer,
  mockBillingLayer,
  notFoundError,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from '../../../helpers/mocks.ts'
import { resolveProvider, runDelete, runDeleteExpectingError, runDiff, runEffect, runReconcile } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

const POLICY_ID = 'pricingpolicy-1'
const PROJECT_ID = 'project-test-1'

const validProps = {
  parentId: PROJECT_ID,
  name: 'gpu-bids',
  platform: 'gpu-h100-sxm',
  maxPrice: '3.000',
}

/**
 * The policy the API would hold — built with `fromJSON`, so `runningVmCount` is a real `Long` and the
 * nested spec is shaped the way the service stores it (the reshape the attributes mapper undoes).
 */
const policyProto = (
  overrides: { runningVmCount?: string; maxPrice?: string; platform?: string } = {},
): NebiusPricingPolicySchema.PricingPolicy => ({
  metadata: protoMetadata(POLICY_ID, validProps.name, PROJECT_ID),
  spec: NebiusPricingPolicySchema.PricingPolicySpec.fromJSON({
    computeInstanceSpec: { v1: { platform: overrides.platform ?? validProps.platform } },
    pricing: { maxPriceV1: { maxPrice: overrides.maxPrice ?? '3' } },
  }),
  status: NebiusPricingPolicySchema.PricingPolicyStatus.fromJSON({
    // The service's own spellings: `STATE_ACTIVE`, not `ACTIVE` (the probe logs agree).
    state: 'STATE_ACTIVE',
    skuId: 'sku-1',
    schedulingState: 'SCHEDULING_STATE_ALLOWED',
    runningVmCount: overrides.runningVmCount ?? '0',
    currency: 'usd',
  }),
})

const base = <A, E, R>(service: Layer.Layer<A, E, R>) =>
  Layer.mergeAll(service, stackLayer, testConfigLayer, instanceIdLayer)

const mocks = (writes: Array<unknown>, policy: () => NebiusPricingPolicySchema.PricingPolicy = () => policyProto()) =>
  base(
    mockBillingLayer({
      pricingPolicy: {
        get: () => Effect.succeed(policy()),
        create: (req: unknown) => {
          writes.push(req)
          return Effect.succeed(policy())
        },
        delete: () => Effect.void,
      },
    }),
  )

const resolvePricingPolicyProvider = () => resolveProvider(Module.NebiusPricingPolicy.Provider, Module.NebiusPricingPolicyProvider)

describe('Nebius.billing.v1.PricingPolicy', () => {
  test('constructor and provider are defined', () => {
    expect(Module.NebiusPricingPolicy).toBeDefined()
    expect(Module.NebiusPricingPolicyProvider).toBeDefined()
  })

  describe('props validation', () => {
    const invalid = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validatePricingPolicyProps({ ...validProps, ...patch }).pipe(Effect.flip))

    test('accepts the baseline, and docs say `maxPrice` is a string', async () => {
      const accepted = await runEffect(SchemaModule.validatePricingPolicyProps(validProps))
      expect(accepted.maxPrice).toBe('3.000')
      expect(typeof accepted.maxPrice).toBe('string')
    })

    test('rejects a price that is not a decimal with ≤ 3 fractional digits', async () => {
      // The API takes a money string, so `3.0000` and `abc` are plan-time errors rather than
      // apply-time surprises — and a bare number would lose the formatting the service echoes.
      expect(String(await invalid({ maxPrice: '3.0000' }))).toContain('is not a price')
      expect(String(await invalid({ maxPrice: 'abc' }))).toContain('is not a price')
      expect(String(await invalid({ maxPrice: '-1.000' }))).toContain('is not a price')
      expect(String(await invalid({ maxPrice: '' }))).toContain('is not a price')
    })

    test('rejects an empty platform and a non-DNS name', async () => {
      expect(String(await invalid({ platform: '' }))).toContain('must not be empty')
      expect(String(await invalid({ name: 'Not A Name' }))).toContain('name')
    })
  })

  describe('attributes', () => {
    test('un-nests the spec and reports the status, in the API’s own spellings', async () => {
      const svc = await resolvePricingPolicyProvider()
      const writes: Array<unknown> = []
      const attrs = await runReconcile(svc, validProps, { id: POLICY_ID }, validProps, Effect.provide(mocks(writes)) as never)
      expect(attrs.id).toBe(POLICY_ID)
      expect(attrs.parentId).toBe(PROJECT_ID)
      expect(attrs.platform).toBe('gpu-h100-sxm')
      // The API normalizes the price it stores: sent `3.000`, held and echoed `3`.
      expect(attrs.maxPrice).toBe('3')
      expect(attrs.state).toBe('STATE_ACTIVE')
      expect(attrs.schedulingState).toBe('SCHEDULING_STATE_ALLOWED')
      expect(attrs.skuId).toBe('sku-1')
      // Lowercase on purpose — measured live 2026-09-24, and the type is the API's string.
      expect(attrs.currency).toBe('usd')
      // int64 through the api-client is a `Long`; attributes surface the decimal string.
      expect(attrs.runningVmCount).toBe('0')
    })
  })

  describe('lifecycle', () => {
    test('creates the policy under its project, with the nested spec and internal labels', async () => {
      const svc = await resolvePricingPolicyProvider()
      const writes: Array<unknown> = []
      const layer = base(
        mockBillingLayer({
          pricingPolicy: {
            get: () => Effect.fail(notFoundError()),
            create: (req: unknown) => {
              writes.push(req)
              return Effect.succeed(policyProto())
            },
          },
        }),
      )
      await runReconcile(svc, validProps, { id: POLICY_ID }, validProps, Effect.provide(layer) as never)
      expect(writes).toHaveLength(1)
      const request = writes[0] as {
        metadata: { parentId: string; name: string; labels: Record<string, string> }
        spec: NebiusPricingPolicySchema.PricingPolicySpec
      }
      expect(request.metadata.parentId).toBe(PROJECT_ID)
      expect(request.metadata.name).toBe('gpu-bids')
      expect(Object.keys(request.metadata.labels).length).toBeGreaterThan(0)
      // The reshape, in the direction that actually travels: nested on the wire.
      expect(request.spec.computeInstanceSpec?.v1?.platform).toBe('gpu-h100-sxm')
      expect(request.spec.pricing?.maxPriceV1?.maxPrice).toBe('3.000')
    })

    test('an existing policy is left alone — there is no update path', async () => {
      const svc = await resolvePricingPolicyProvider()
      const writes: Array<unknown> = []
      await runReconcile(svc, validProps, { id: POLICY_ID }, validProps, Effect.provide(mocks(writes)) as never)
      expect(writes).toHaveLength(0)
    })

    test('delete refuses while the policy still prices running VMs', async () => {
      const svc = await resolvePricingPolicyProvider()
      const layer = base(
        mockBillingLayer({
          pricingPolicy: {
            get: () => Effect.succeed(policyProto({ runningVmCount: '2' })),
            delete: () => Effect.void,
          },
        }),
      )
      const error = await runDeleteExpectingError(svc, { id: POLICY_ID }, validProps, Effect.provide(layer) as never)
      // The API says FAILED_PRECONDITION; the provider says what to do about it, and the count is in
      // `status` — the GpuClusterNotEmpty pattern.
      expect(String(error.message ?? error)).toContain('2 running VM(s)')
    })

    test('delete tolerates NOT_FOUND (idempotent, like makeCrudDelete)', async () => {
      const svc = await resolvePricingPolicyProvider()
      const layer = base(
        mockBillingLayer({
          pricingPolicy: { get: () => Effect.fail(notFoundError()), delete: () => Effect.fail(notFoundError()) },
        }),
      )
      await runDelete(svc, { id: POLICY_ID }, validProps, Effect.provide(layer) as never)
    })
  })

  describe('diff — the only convergence path (no update RPC)', () => {
    test('an identical config plans nothing', async () => {
      const svc = await resolvePricingPolicyProvider()
      expect(await runDiff(svc, { ...validProps }, { ...validProps })).toBeUndefined()
    })

    test('a labels-only change plans nothing — declared, not lost silently', async () => {
      const svc = await resolvePricingPolicyProvider()
      expect(
        await runDiff(svc, { ...validProps, labels: { team: 'ml' } }, { ...validProps }),
      ).toBeUndefined()
    })

    test('identity changes are create-first; spec changes are delete-first', async () => {
      const svc = await resolvePricingPolicyProvider()
      // A different name or parent can coexist with the old generation.
      expect(await runDiff(svc, { ...validProps, name: 'other' }, validProps)).toEqual({
        action: 'replace',
      })
      expect(await runDiff(svc, { ...validProps, parentId: 'project-2' }, validProps)).toEqual({
        action: 'replace',
      })
      // A spec change reuses `(parent, name)`, so the replacement must delete first — a create-first
      // generation would die with ALREADY_EXISTS while the old one still holds the name.
      expect(await runDiff(svc, { ...validProps, maxPrice: '3.500' }, validProps)).toEqual({
        action: 'replace',
        deleteFirst: true,
      })
      expect(await runDiff(svc, { ...validProps, platform: 'gpu-h200-sxm' }, validProps)).toEqual({
        action: 'replace',
        deleteFirst: true,
      })
      // …and with a *generated* name it stays create-first, because the name is minted fresh per
      // generation (`Factory.replaceKeepingName`).
      const { name: _dropped, ...withoutName } = validProps
      expect(await runDiff(svc, { ...withoutName, maxPrice: '3.500' }, withoutName)).toEqual({
        action: 'replace',
      })
    })

    test('the price is compared as written, not as the API renders it', async () => {
      const svc = await resolvePricingPolicyProvider()
      // `diff` compares props to stored props, so the API's normalization (`3.000` → `3`) never shows
      // up here: re-applying the same config is a noop even though the live echo differs.
      expect(await runDiff(svc, { ...validProps, maxPrice: '3.000' }, { ...validProps, maxPrice: '3.000' })).toBeUndefined()
      // A *reformatted* price is a real config change, and a replacement is the only way it can land.
      expect(await runDiff(svc, { ...validProps, maxPrice: '3' }, validProps)).toEqual({
        action: 'replace',
        deleteFirst: true,
      })
    })
  })
})
