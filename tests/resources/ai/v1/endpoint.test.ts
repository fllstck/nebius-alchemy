import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Module from '../../../../modules/resources/ai/v1/endpoint.ts'
import * as SchemaModule from '../../../../modules/resources/ai/v1/endpoint.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

/** Minimal valid Endpoint props (all required fields populated). */
const validEndpointProps = {
  image: 'nginx:latest',
  platform: 'cpu-d3',
  preset: '4vcpu-16gb',
  subnetId: 'subnet-abc123',
  publicIp: true,
  preemptible: false,
  environmentVariables: [],
  ports: [{ containerPort: 80, protocol: 'HTTP' }],
  volumes: [],
  disk: { type: 'NETWORK_SSD', sizeBytes: 107_374_182_400 }, // 100 GiB (≥ 64 GiB floor)
}

describe('Nebius.ai.v1.Endpoint', () => {
  test('NebiusEndpoint resource constructor is defined', () => {
    expect(Module.NebiusEndpoint).toBeDefined()
    expect(typeof Module.NebiusEndpoint).toBe('function')
  })

  test('NebiusEndpointProvider is defined', () => {
    expect(Module.NebiusEndpointProvider).toBeDefined()
  })

  describe('pricing (pricing_model)', () => {
    // Same shape as the Job's (they share the `pricingModel` message and the arm rules): the prop is a
    // reshape of a flat oneof, nested back under `pricingModel` by `endpointSpecInput`, and the arm is
    // coupled to `preemptible` ("Must match the preemptible flag").
    const invalidPricing = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validateEndpointProps({ ...validEndpointProps, ...patch }).pipe(Effect.flip))
    const validPricing = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validateEndpointProps({ ...validEndpointProps, ...patch }))

    test('each arm is accepted on its matching preemptible flag', async () => {
      await validPricing({ pricing: { onDemand: true } })
      await validPricing({ preemptible: true, pricing: { followsSpotPrice: true } })
      await validPricing({ preemptible: true, pricing: { spotPricingPolicy: { id: 'pricingpolicy-1' } } })
      await validPricing({})
      await validPricing({ preemptible: true })
    })

    test('“exactly one arm” and the preemptible coupling are plan-time errors', async () => {
      expect(String(await invalidPricing({ pricing: { onDemand: true, followsSpotPrice: true } }))).toContain(
        'exactly one',
      )
      expect(String(await invalidPricing({ pricing: {} }))).toContain('exactly one')
      expect(String(await invalidPricing({ preemptible: true, pricing: { onDemand: true } }))).toContain(
        'Must match the preemptible flag',
      )
      expect(String(await invalidPricing({ pricing: { followsSpotPrice: true } }))).toContain('requires `preemptible`')
      expect(String(await invalidPricing({ pricing: { onDemand: false } }))).toContain('can only be set to true')
    })

    test('endpointSpecInput nests the arms under `pricingModel`, and leaves no `pricing` key', () => {
      const onDemand = Module.endpointSpecInput({ ...validEndpointProps, pricing: { onDemand: true } } as never)
      expect(onDemand.pricing).toBeUndefined()
      expect(onDemand.pricingModel).toEqual({ onDemand: {} })

      const policy = Module.endpointSpecInput({
        ...validEndpointProps,
        preemptible: true,
        pricing: { spotPricingPolicy: { id: 'pricingpolicy-1' } },
      } as never)
      expect(policy.pricingModel).toEqual({ spotPricingPolicy: { id: 'pricingpolicy-1' } })

      const omitted = Module.endpointSpecInput(validEndpointProps as never)
      expect(omitted.pricing).toBeUndefined()
      expect(omitted.pricingModel).toBeUndefined()
    })
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusEndpoint.Provider, Module.NebiusEndpointProvider)
      expect(await runDiff(svc, { ...validEndpointProps, name: 'new-endpoint' }, { ...validEndpointProps, name: 'old-endpoint' })).toEqual({ action: 'replace' })
    })

    test('spec change (image) requires replace — no update RPC', async () => {
      const svc = await resolveProvider(Module.NebiusEndpoint.Provider, Module.NebiusEndpointProvider)
      expect(await runDiff(svc, { ...validEndpointProps, image: 'nginx:1.27' }, { ...validEndpointProps, image: 'nginx:1.26' })).toEqual({
        action: 'replace',
      })
    })

    test('identical props is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusEndpoint.Provider, Module.NebiusEndpointProvider)
      expect(
        await runDiff(svc, { ...validEndpointProps }, { ...validEndpointProps }),
      ).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props (incl. plain authToken)', async () => {
      const result = await runEffect(
        SchemaModule.validateEndpointProps({ ...validEndpointProps, authToken: 'secret-token' }),
      )
      expect(result.image).toBe('nginx:latest')
      expect(result.authToken).toBe('secret-token')
    })

    test('accepts props with neither authToken nor authTokenMysteryboxSecret', async () => {
      const result = await runEffect(SchemaModule.validateEndpointProps(validEndpointProps))
      expect(result.ports[0].protocol).toBe('HTTP')
    })

    test('rejects both authToken and authTokenMysteryboxSecret (XOR)', async () => {
      const result = await runEffect(
        SchemaModule.validateEndpointProps({
          ...validEndpointProps,
          authToken: 'secret-token',
          authTokenMysteryboxSecret: { secretId: 'sec-abc123', versionId: 'ver-abc123' },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects missing disk (required by the API)', async () => {
      const { disk: _disk, ...withoutDisk } = validEndpointProps
      const result = await runEffect(
        SchemaModule.validateEndpointProps(withoutDisk).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects disks below the 64 GiB provisioning floor', async () => {
      const result = await runEffect(
        SchemaModule.validateEndpointProps({
          ...validEndpointProps,
          disk: { type: 'NETWORK_SSD', sizeBytes: 32 * 1024 ** 3 },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('accepts exactly 64 GiB (the proven provisioning floor)', async () => {
      const result = await runEffect(
        SchemaModule.validateEndpointProps({
          ...validEndpointProps,
          disk: { type: 'NETWORK_SSD', sizeBytes: 64 * 1024 ** 3 },
        }),
      )
      expect(result.disk.sizeBytes).toBe(64 * 1024 ** 3)
    })

    test('rejects bad base64 in injectedFiles', async () => {
      const result = await runEffect(
        SchemaModule.validateEndpointProps({
          ...validEndpointProps,
          injectedFiles: [{ containerPath: '/etc/app.conf', content: 'not base64!!!' }],
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })

  describe('attributes', () => {
    test('EndpointAttributesSchema carries authToken (binding support, AD1)', async () => {
      const attrs = {
        id: 'endpoint-abc123',
        parentId: 'project-abc123',
        name: 'my-endpoint',
        labels: [],
        state: 'RUNNING',
        publicEndpoints: ['https://ep-abc123.public.api.nebius.cloud'],
        privateEndpoints: [],
        authToken: 'secret-token',
      }
      const decoded = await runEffect(Schema.decodeUnknownEffect(SchemaModule.EndpointAttributesSchema)(attrs))
      expect(decoded.authToken).toBe('secret-token')
      expect(decoded.state).toBe('RUNNING')
    })

    test('EndpointAttributesSchema decodes without authToken (read/list paths)', async () => {
      const attrs = {
        id: 'endpoint-abc123',
        parentId: 'project-abc123',
        name: 'my-endpoint',
        labels: [],
        state: 'RUNNING',
        publicEndpoints: [],
        privateEndpoints: [],
      }
      const decoded = await runEffect(Schema.decodeUnknownEffect(SchemaModule.EndpointAttributesSchema)(attrs))
      expect(decoded.authToken).toBeUndefined()
    })
  })
})
