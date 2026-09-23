import * as BunTest from 'bun:test'
import Long from 'long'
import * as AlchemyDiff from 'alchemy/Diff'

import { specDeepEqual, pinnedSpecDeepEqual, protoPinnedFields } from '../../modules/resources/utilities.ts'
import * as DiskSchema from '../../schemas/nebius/compute/v1/disk.ts'
import * as SymmetricKeySchema from '../../schemas/nebius/kms/v1/symmetric_key.ts'
import * as NodeGroupSchema from '../../schemas/nebius/mk8s/v1/node_group.ts'

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

/**
 * The other half of the int64 story. `specDeepEqual` answers "are these two messages
 * equal"; a no-`FieldMask` API cannot be asked that question at all, because an omitted
 * field is not "clear it" and the platform materializes defaults into what it echoes.
 *
 * `pinnedSpecDeepEqual` compares only the fields the caller pinned, and
 * `protoPinnedFields` is what turns a `fromJSON`-built message (which holds a value for
 * *every* scalar) into the pin set. Both were added for `mk8s/v1 NodeGroup`, whose
 * `NodeTemplate` is 17 fields of 12 nested messages.
 */
describe('pinnedSpecDeepEqual + protoPinnedFields (the no-FieldMask comparison)', () => {
  test('an omitted field is never compared — the materialized default cannot loop', () => {
    // The live shape: the caller pinned the size, the platform echoed a block size too.
    expect(pinnedSpecDeepEqual({ sizeGibibytes: 64, blockSizeBytes: 4096 }, { sizeGibibytes: 64 })).toBe(true)
    // …and the same shape, but the pinned field really did drift.
    expect(pinnedSpecDeepEqual({ sizeGibibytes: 32, blockSizeBytes: 4096 }, { sizeGibibytes: 64 })).toBe(false)
  })

  test('int64s stay visible at the leaves', () => {
    // The reason this delegates to `specDeepEqual` instead of `AlchemyDiff.deepEqual`:
    // the framework helper reports these two as equal.
    expect(AlchemyDiff.deepEqual(Long.fromNumber(1), Long.fromNumber(3))).toBe(true)
    expect(pinnedSpecDeepEqual({ fixedNodeCount: Long.fromNumber(1) }, { fixedNodeCount: Long.fromNumber(3) })).toBe(
      false,
    )
    expect(pinnedSpecDeepEqual({ fixedNodeCount: Long.fromNumber(3) }, { fixedNodeCount: Long.fromNumber(3) })).toBe(
      true,
    )
  })

  test('an absent message is drift when one was pinned, and equal when none was', () => {
    expect(pinnedSpecDeepEqual(undefined, { os: 'ubuntu24.04' })).toBe(false)
    expect(pinnedSpecDeepEqual({ os: 'ubuntu24.04' }, undefined)).toBe(true)
    // A message where live is a scalar is a shape change, not an unpinned field.
    expect(pinnedSpecDeepEqual('ubuntu24.04', { os: 'ubuntu24.04' })).toBe(false)
  })

  test('an empty object compares presence, not nothing (presence-only switches)', () => {
    // `publicIpAddress: {}` means "attach a public address" — so an absent live message
    // is drift. `toEqual({})` semantics would have said "no difference".
    expect(pinnedSpecDeepEqual(undefined, {})).toBe(false)
    expect(pinnedSpecDeepEqual({}, {})).toBe(true)
    expect(pinnedSpecDeepEqual({ subnetId: 'vpcsubnet-1' }, {})).toBe(true)
  })

  test('arrays compare element-wise by index and by length', () => {
    // A materialized sibling inside an array element is ignored…
    expect(
      pinnedSpecDeepEqual(
        [{ subnetId: 'vpcsubnet-1', publicIpAddress: undefined, securityGroups: [] }],
        [{ subnetId: 'vpcsubnet-1' }],
      ),
    ).toBe(true)
    // …but the element that was pinned is compared, and so is the count.
    expect(pinnedSpecDeepEqual([{ subnetId: 'vpcsubnet-2' }], [{ subnetId: 'vpcsubnet-1' }])).toBe(false)
    expect(
      pinnedSpecDeepEqual([{ subnetId: 'a' }, { subnetId: 'b' }], [{ subnetId: 'a' }]),
    ).toBe(false)
    expect(pinnedSpecDeepEqual(undefined, [{ subnetId: 'a' }])).toBe(false)
  })

  test('nested pins survive: an unpinned sibling does not hide a pinned one', () => {
    expect(
      pinnedSpecDeepEqual(
        { bootDisk: { sizeGibibytes: 64, blockSizeBytes: 4096 } },
        { bootDisk: { sizeGibibytes: 64 } },
      ),
    ).toBe(true)
    expect(
      pinnedSpecDeepEqual(
        { bootDisk: { sizeGibibytes: 32, blockSizeBytes: 4096 } },
        { bootDisk: { sizeGibibytes: 64 } },
      ),
    ).toBe(false)
  })

  test('protoPinnedFields drops proto3 defaults, keeps real values and empty messages', () => {
    const cleaned: Record<string, unknown> = protoPinnedFields({
      version: '',
      fixedNodeCount: Long.ZERO,
      template: { os: 'ubuntu24.04', taints: [], maxPods: Long.ZERO, publicIpAddress: {}, nested: undefined },
    })
    expect(cleaned).toEqual({ template: { os: 'ubuntu24.04', publicIpAddress: {} } })
    // A non-zero Long is a pin and stays a `Long` (so `specDeepEqual` normalizes it).
    expect(protoPinnedFields({ fixedNodeCount: Long.fromNumber(2) })).toEqual({
      fixedNodeCount: Long.fromNumber(2),
    })
  })

  test('the pair is what makes a fromJSON message comparable', () => {
    // A realistic ts-proto message: every scalar field carries a value whether or not the
    // caller set it, so `Object.keys` alone would compare `maxPods: 0` against the
    // platform's own default forever.
    const desired = NodeGroupSchema.NodeGroupSpec.fromJSON({
      fixedNodeCount: 1,
      template: { os: 'ubuntu24.04', resources: { platform: 'cpu-d3' }, bootDisk: { sizeGibibytes: 64, type: 'NETWORK_SSD' } },
    })
    const live = NodeGroupSchema.NodeGroupSpec.fromJSON({
      fixedNodeCount: '1',
      template: {
        os: 'ubuntu24.04',
        resources: { platform: 'cpu-d3' },
        bootDisk: { sizeGibibytes: '64', type: 'NETWORK_SSD', blockSizeBytes: '4096' },
        // The platform's own additions — none of them pinned by the caller.
        maxPods: '110',
        taints: [],
        networkInterfaces: [],
      },
    })
    expect(pinnedSpecDeepEqual(live, protoPinnedFields(desired))).toBe(true)
    // The same comparison with a drifted pin still bites.
    const drifted = { ...live, template: { ...live.template!, bootDisk: { ...live.template!.bootDisk!, sizeGibibytes: Long.fromNumber(32) } } }
    expect(pinnedSpecDeepEqual(drifted, protoPinnedFields(desired))).toBe(false)
  })
})
