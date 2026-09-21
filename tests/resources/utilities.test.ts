import * as BunTest from 'bun:test'
import Long from 'long'
import * as AlchemyDiff from 'alchemy/Diff'

import { specDeepEqual } from '../../modules/resources/utilities.ts'
import * as DiskSchema from '../../schemas/nebius/compute/v1/disk.ts'
import * as SymmetricKeySchema from '../../schemas/nebius/kms/v1/symmetric_key.ts'

const { describe, expect, test } = BunTest

/**
 * The trap this pins (found 2026-09-19 while adding `NVLInstanceGroup`):
 * `AlchemyDiff.deepEqual` canonicalizes non-plain objects — class instances — to
 * `undefined`, and `long`'s `Long` is one. So every int64 compares equal to every
 * other, and any provider comparing a spec that holds one is blind to it.
 *
 * The first test documents the framework behaviour (if alchemy ever fixes it,
 * this test fails and `specDeepEqual` can be simplified); the rest pin the fix.
 */
describe('specDeepEqual (int64-blind deepEqual workaround)', () => {
  test('the trap: alchemy deepEqual reports two different Longs as equal', () => {
    expect(AlchemyDiff.deepEqual(Long.fromNumber(2), Long.fromNumber(8))).toBe(true)
    expect(AlchemyDiff.deepEqual({ size: Long.fromNumber(2) }, { size: Long.fromNumber(8) })).toBe(true)
  })

  test('specDeepEqual sees the difference at the top level and nested', () => {
    expect(specDeepEqual(Long.fromNumber(2), Long.fromNumber(8))).toBe(false)
    expect(specDeepEqual({ size: Long.fromNumber(2) }, { size: Long.fromNumber(8) })).toBe(false)
    expect(specDeepEqual([{ size: Long.fromNumber(2) }], [{ size: Long.fromNumber(8) }])).toBe(false)
    // Equal Longs still compare equal, and unrelated shapes keep their behaviour.
    expect(specDeepEqual({ size: Long.fromNumber(8) }, { size: Long.fromNumber(8) })).toBe(true)
    expect(specDeepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(specDeepEqual({ a: 1, b: null }, { b: null, a: 1 })).toBe(true)
  })

  test('a real DiskSpec size change is invisible to deepEqual and visible to specDeepEqual', () => {
    const live = DiskSchema.DiskSpec.fromJSON({ type: 'NETWORK_SSD', sizeGibibytes: '64' })
    const desired = DiskSchema.DiskSpec.fromJSON({ type: 'NETWORK_SSD', sizeGibibytes: '128' })

    expect(AlchemyDiff.deepEqual(live, desired)).toBe(true)
    expect(specDeepEqual(live, desired)).toBe(false)
    // ...while a non-int64 change is detected by both.
    const otherType = DiskSchema.DiskSpec.fromJSON({ type: 'NETWORK_HDD', sizeGibibytes: '64' })
    expect(AlchemyDiff.deepEqual(live, otherType)).toBe(false)
  })

  test('a Duration (Long seconds) nested in a spec is visible', () => {
    const withRotation = SymmetricKeySchema.SymmetricKeySpec.fromJSON({
      algorithm: 'AES_256',
      rotationPeriod: { seconds: '2592000' },
    })
    const otherRotation = SymmetricKeySchema.SymmetricKeySpec.fromJSON({
      algorithm: 'AES_256',
      rotationPeriod: { seconds: '86400' },
    })

    // The nested `Duration.seconds` is a Long — invisible to plain deepEqual.
    expect(AlchemyDiff.deepEqual(withRotation.rotationPeriod, otherRotation.rotationPeriod)).toBe(true)
    expect(specDeepEqual(withRotation.rotationPeriod, otherRotation.rotationPeriod)).toBe(false)
    expect(specDeepEqual(withRotation, otherRotation)).toBe(false)
  })

  test('a null-prototype map is walked too (not every object literal is a plain object)', () => {
    // `normalizeLongs` skips anything that is not a plain object, because walking class
    // instances is the very hazard `deepEqual` guards against — but a null-prototype map
    // (`Object.create(null)`, as some JSON/decoder paths produce) is data, not a class,
    // and its Longs must still be normalized. This is the only surviving mutant of the
    // module: `proto !== null` → `true` in the guard.
    const withLong = (n: number) => Object.assign(Object.create(null), { size: Long.fromNumber(n) })

    expect(specDeepEqual(withLong(2), withLong(8))).toBe(false)
    expect(specDeepEqual(withLong(8), withLong(8))).toBe(true)
  })

  test('non-plain values keep the framework rule (not walked, treated as absent)', () => {
    // An Effect/Layer-like object must NOT be walked — that is the cyclic-walk
    // hazard the canonicalizer's rule exists for.
    class Opaque {
      constructor(readonly tag: string) {}
    }
    expect(specDeepEqual(new Opaque('a'), new Opaque('b'))).toBe(true)
  })
})
