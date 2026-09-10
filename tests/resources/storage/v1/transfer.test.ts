import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/storage/v1/transfer.ts'
import * as SchemaModule from '../../../../modules/resources/storage/v1/transfer.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

/** Minimal valid Transfer props (all required sub-schemas populated). */
const validTransferProps = {
  name: 'my-transfer',
  source: { nebius: { region: 'eu-west1', bucketName: 'src-bucket' } },
  destination: {
    nebius: {
      region: 'eu-west1',
      bucketName: 'dst-bucket',
      accessKey: { accessKeyId: 'ak-1', secretAccessKey: 'sk-1' },
    },
  },
  stopCondition: { afterOneIteration: true },
  overwriteStrategy: 'NEVER',
}

describe('Nebius.storage.v1.Transfer', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusTransfer).toBeDefined()
    expect(typeof Module.NebiusTransfer).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusTransferProvider).toBeDefined()
  })

  describe('diff', () => {
    test('source change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusTransfer.Provider, Module.NebiusTransferProvider)
      expect(await runDiff(svc, { ...validTransferProps, source: { nebius: { region: 'eu-west1', bucketName: 'src-b' } } }, { ...validTransferProps, source: { nebius: { region: 'eu-west1', bucketName: 'src-a' } } })).toEqual({ action: 'replace' })
    })

    test('overwriteStrategy change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusTransfer.Provider, Module.NebiusTransferProvider)
      expect(await runDiff(svc, { ...validTransferProps, overwriteStrategy: 'IF_NEWER' }, { ...validTransferProps, overwriteStrategy: 'NEVER' })).toEqual({ action: 'replace' })
    })

    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusTransfer.Provider, Module.NebiusTransferProvider)
      expect(await runDiff(svc, { ...validTransferProps, name: 'new-transfer' }, { ...validTransferProps, name: 'old-transfer' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusTransfer.Provider, Module.NebiusTransferProvider)
      expect(await runDiff(svc, { ...validTransferProps }, { ...validTransferProps })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SchemaModule.validateTransferProps(validTransferProps))
      expect(result.name).toBe('my-transfer')
    })

    test('rejects an unknown overwriteStrategy', async () => {
      const result = await runEffect(
        SchemaModule.validateTransferProps({ ...validTransferProps, overwriteStrategy: 'ALWAYS' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
