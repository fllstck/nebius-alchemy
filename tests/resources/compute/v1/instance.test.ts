import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/compute/v1/instance'
import * as SchemaModule from '../../../../modules/resources/compute/v1/instance.schema'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider'

const { describe, expect, test } = BunTest

/** Minimal valid Instance props (all required sub-schemas populated). */
const validInstanceProps = {
  serviceAccountId: 'sa-abc123',
  resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
  bootDisk: {
    attachMode: 'READ_WRITE',
    managedDisk: { name: 'boot-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 10 } },
  },
  networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0' }],
}

describe('Nebius.compute.v1.Instance', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusInstance).toBeDefined()
    expect(typeof Module.NebiusInstance).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusInstanceProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(await runDiff(svc, { name: 'new-instance' }, { name: 'old-instance' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusInstance.Provider, Module.NebiusInstanceProvider)
      expect(await runDiff(svc, { name: 'my-instance' }, { name: 'my-instance' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps(validInstanceProps),
      )
      expect(result.serviceAccountId).toBe('sa-abc123')
    })

    test('rejects a GPU preset on a CPU platform', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          resources: { platform: 'cpu-d3', preset: '8gpu-128vcpu-1600gb' },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects a boot disk with neither existingDisk nor managedDisk', async () => {
      const result = await runEffect(
        SchemaModule.validateInstanceProps({
          ...validInstanceProps,
          bootDisk: { attachMode: 'READ_WRITE' },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
