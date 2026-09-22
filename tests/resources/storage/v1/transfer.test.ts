import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/storage/v1/transfer.ts'
import * as SchemaModule from '../../../../modules/resources/storage/v1/transfer.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

/** Minimal valid Transfer props (all required sub-schemas populated). */
const validTransferProps = {
  name: 'my-transfer',
  source: {
    nebius: {
      region: 'eu-west1',
      bucketName: 'src-bucket',
      // REQUIRED by the API although the proto marks it optional — without it
      // `TransferService/Create` answers a bare `3 INVALID_ARGUMENT` (probed live 2026-09-22).
      accessKey: { accessKeyId: 'ak-src', secretAccessKey: 'sk-src' },
    },
  },
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

/**
 * A deep clone of the props — what the state store hands `diff` as `olds` on a re-apply.
 *
 * A shallow spread (`{ ...validTransferProps }`) shares the nested `source`/`destination`
 * objects, which made the old reference comparison pass vacuously and hid the bug below.
 */
const storedProps = () => JSON.parse(JSON.stringify(validTransferProps))

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
      // Pinned name (`validTransferProps.name`) ⇒ delete-first: the replacement
      // cannot be created while the old generation holds the name.
      expect(await runDiff(svc, { ...validTransferProps, source: { nebius: { ...validTransferProps.source.nebius, bucketName: 'src-b' } } }, storedProps())).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('a rotated source access key requires replace (credentials are not an update)', async () => {
      const svc = await resolveProvider(Module.NebiusTransfer.Provider, Module.NebiusTransferProvider)
      expect(
        await runDiff(
          svc,
          {
            ...validTransferProps,
            source: {
              nebius: {
                ...validTransferProps.source.nebius,
                accessKey: { accessKeyId: 'ak-rotated', secretAccessKey: 'sk-rotated' },
              },
            },
          },
          storedProps(),
        ),
      ).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('overwriteStrategy change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusTransfer.Provider, Module.NebiusTransferProvider)
      expect(await runDiff(svc, { ...validTransferProps, overwriteStrategy: 'IF_NEWER' }, { ...validTransferProps, overwriteStrategy: 'NEVER' })).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusTransfer.Provider, Module.NebiusTransferProvider)
      expect(await runDiff(svc, { ...validTransferProps, name: 'new-transfer' }, storedProps())).toEqual({
        action: 'replace',
      })
    })

    test('no change is a noop — structurally equal, never the same reference', async () => {
      const svc = await resolveProvider(Module.NebiusTransfer.Provider, Module.NebiusTransferProvider)
      // `storedProps()` is the point of this test: the planner hands `diff` a fresh config object
      // against the persisted props, so object-valued props are structurally equal but never the
      // same reference. Comparing them with `!==` planned a replace on EVERY deploy, and the
      // create-first replacement of a transfer that still held its destination died with
      // `6 ALREADY_EXISTS: Transfer with overlapping destination exists` (probed live 2026-09-22).
      expect(await runDiff(svc, validTransferProps, storedProps())).toBeUndefined()
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

    test('rejects a Nebius source without an access key (the API requires one)', async () => {
      const result = await runEffect(
        SchemaModule.validateTransferProps({
          ...validTransferProps,
          source: { nebius: { region: 'eu-west1', bucketName: 'src-bucket' } },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
