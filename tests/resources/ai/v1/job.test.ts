import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/ai/v1/job.ts'
import * as SchemaModule from '../../../../modules/resources/ai/v1/job.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

/** Minimal valid Job props (all required fields populated). */
const validJobProps = {
  image: 'ubuntu:22.04',
  platform: 'cpu-d3',
  preset: '4vcpu-16gb',
  subnetId: 'subnet-abc123',
  publicIp: false,
  preemptible: false,
  containerCommand: 'sleep',
  environmentVariables: [{ name: 'FOO', value: 'bar' }],
  ports: [{ containerPort: 8080, protocol: 'HTTP' }],
  volumes: [],
  disk: { type: 'NETWORK_SSD', sizeBytes: 10_737_418_240 },
}

describe('Nebius.ai.v1.Job', () => {
  test('NebiusJob resource constructor is defined', () => {
    expect(Module.NebiusJob).toBeDefined()
    expect(typeof Module.NebiusJob).toBe('function')
  })

  test('NebiusJobProvider is defined', () => {
    expect(Module.NebiusJobProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      expect(await runDiff(svc, { name: 'new-job' }, { name: 'old-job' })).toEqual({ action: 'replace' })
    })

    test('spec change (image) requires replace — no update RPC', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      expect(await runDiff(svc, { image: 'ubuntu:24.04' }, { image: 'ubuntu:22.04' })).toEqual({
        action: 'replace',
      })
    })

    test('identical props is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      expect(await runDiff(svc, { image: 'ubuntu:22.04', name: 'my-job' }, { image: 'ubuntu:22.04', name: 'my-job' })).toBeUndefined()
    })

    test('labels-only change is a noop (documented drift)', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      expect(
        await runDiff(svc, { image: 'ubuntu:22.04', labels: { team: 'b' } }, { image: 'ubuntu:22.04', labels: { team: 'a' } }),
      ).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props (incl. mysterybox secret refs + base64 injected files)', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({
          ...validJobProps,
          environmentVariables: [
            { name: 'FOO', value: 'bar' },
            { name: 'SECRET', mysteryboxSecret: { secretId: 'sec-abc123', versionId: 'ver-abc123' } },
          ],
          injectedFiles: [{ containerPath: '/etc/app.conf', content: Buffer.from('{"a":1}').toString('base64') }],
        }),
      )
      expect(result.image).toBe('ubuntu:22.04')
      expect(result.environmentVariables[1].mysteryboxSecret?.secretId).toBe('sec-abc123')
    })

    test('rejects unknown disk type', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({
          ...validJobProps,
          disk: { type: 'NOT_A_TYPE', sizeBytes: 10_737_418_240 },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects missing disk (required by the API)', async () => {
      const { disk: _disk, ...withoutDisk } = validJobProps
      const result = await runEffect(
        SchemaModule.validateJobProps(withoutDisk).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({ ...validJobProps, name: 'Bad Name!' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects an environment variable with both value and mysteryboxSecret (XOR)', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({
          ...validJobProps,
          environmentVariables: [
            { name: 'FOO', value: 'bar', mysteryboxSecret: { secretId: 'sec-abc123', versionId: 'ver-abc123' } },
          ],
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
