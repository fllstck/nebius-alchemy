import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
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
  disk: { type: 'NETWORK_SSD', sizeBytes: 10_737_418_240 },
}

describe('Nebius.ai.v1.Endpoint', () => {
  test('NebiusEndpoint resource constructor is defined', () => {
    expect(Module.NebiusEndpoint).toBeDefined()
    expect(typeof Module.NebiusEndpoint).toBe('function')
  })

  test('NebiusEndpointProvider is defined', () => {
    expect(Module.NebiusEndpointProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusEndpoint.Provider, Module.NebiusEndpointProvider)
      expect(await runDiff(svc, { name: 'new-endpoint' }, { name: 'old-endpoint' })).toEqual({ action: 'replace' })
    })

    test('spec change (image) requires replace — no update RPC', async () => {
      const svc = await resolveProvider(Module.NebiusEndpoint.Provider, Module.NebiusEndpointProvider)
      expect(await runDiff(svc, { image: 'nginx:1.27' }, { image: 'nginx:1.26' })).toEqual({
        action: 'replace',
      })
    })

    test('identical props is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusEndpoint.Provider, Module.NebiusEndpointProvider)
      expect(
        await runDiff(svc, { image: 'nginx:latest', name: 'my-endpoint' }, { image: 'nginx:latest', name: 'my-endpoint' }),
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
})
