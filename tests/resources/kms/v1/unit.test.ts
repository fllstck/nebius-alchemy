import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Module from '../../../../modules/resources/kms/v1/symmetric-key.ts'
import * as SchemaModule from '../../../../modules/resources/kms/v1/symmetric-key.schema.ts'
import * as NebiusSymmetricKeySchema from '../../../../schemas/nebius/kms/v1/symmetric_key.ts'
import { runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.kms.v1.SymmetricKey', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusSymmetricKey).toBeDefined()
    expect(typeof Module.NebiusSymmetricKey).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusSymmetricKeyProvider).toBeDefined()
  })


  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateSymmetricKeyProps({ name: 'my-key', algorithm: 'AES_256' }),
      )
      expect(result.algorithm).toBe('AES_256')
    })

    test('rejects an unknown algorithm', async () => {
      const result = await runEffect(
        SchemaModule.validateSymmetricKeyProps({ algorithm: 'NOT_AN_ALGORITHM' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    // ── rotation period (Task 7b schema-audit gaps) ───────────────────────
    // `rotation_period` was in the generated SymmetricKeySpec but absent from
    // the props schema, so a key could not be given a rotation period at all.
    test('accepts a rotation period within the platform bounds', async () => {
      const result = await runEffect(
        SchemaModule.validateSymmetricKeyProps({ name: 'my-key', rotationPeriodSeconds: 2_592_000 }),
      )
      expect(result.rotationPeriodSeconds).toBe(2_592_000)
    })

    test('rejects a rotation period below one day', async () => {
      const result = await runEffect(
        SchemaModule.validateSymmetricKeyProps({ name: 'my-key', rotationPeriodSeconds: 3_600 }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects a rotation period above ten years', async () => {
      const result = await runEffect(
        SchemaModule.validateSymmetricKeyProps({ name: 'my-key', rotationPeriodSeconds: 315_360_001 }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('serialises the period as a protobuf Duration of whole seconds', () => {
      // The provider reshapes `rotationPeriodSeconds` into `{ seconds }` because
      // the generated Duration.fromJSON only understands the message form — the
      // protobuf JSON string form is silently dropped (asserted below), which is
      // exactly the trap the `...Seconds` prop exists to avoid.
      const spec = NebiusSymmetricKeySchema.SymmetricKeySpec.fromJSON({
        description: '',
        algorithm: 'AES_256',
        rotationPeriod: { seconds: '2592000' },
      })
      expect(spec.rotationPeriod?.seconds.toString()).toBe('2592000')
      expect(spec.algorithm).toBe(NebiusSymmetricKeySchema.SymmetricAlgorithm.AES_256)

      const fromStringForm = NebiusSymmetricKeySchema.SymmetricKeySpec.fromJSON({
        rotationPeriod: '2592000s',
      })
      expect(fromStringForm.rotationPeriod?.seconds.toString()).toBe('0')
    })
  })
})
