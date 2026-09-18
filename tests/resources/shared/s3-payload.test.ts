import { describe, expect, test } from 'bun:test'
import { asArrayBufferBacked } from '../../../modules/resources/shared/s3-payload.ts'

describe('s3-payload', () => {
  describe('asArrayBufferBacked', () => {
    test('re-views an ArrayBuffer-backed value without copying', () => {
      const bytes = new Uint8Array([1, 2, 3, 4])
      const normalized = asArrayBufferBacked(bytes)

      expect([...normalized]).toEqual([1, 2, 3, 4])
      // Same underlying buffer, zero-copy — this is a type narrowing, not a transform.
      expect(normalized.buffer).toBe(bytes.buffer)
      expect(normalized.byteOffset).toBe(0)
      expect(normalized.byteLength).toBe(4)
    })

    test('preserves the window of an offset view', () => {
      // The bug this guards: dropping byteOffset/byteLength when re-viewing would make
      // an offset view upload the bytes *around* it too — silent payload corruption on
      // every upload that hands us a subarray.
      const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
      const view = backing.subarray(2, 5)
      const normalized = asArrayBufferBacked(view)

      expect([...normalized]).toEqual([2, 3, 4])
      expect(normalized.byteOffset).toBe(2)
      expect(normalized.byteLength).toBe(3)
      expect(normalized.buffer).toBe(backing.buffer)
    })

    test('copies a SharedArrayBuffer-backed view into a private ArrayBuffer', () => {
      // SharedArrayBuffer is not `ArrayBuffer`, which is what s3-lite-client 1.0's
      // `Uint8Array_` (`Uint8Array<ArrayBuffer>`) requires at the type level — and a
      // shared buffer can be mutated by another thread mid-upload, so snapshot it.
      const shared = new Uint8Array(new SharedArrayBuffer(4))
      shared.set([9, 8, 7, 6])

      const normalized = asArrayBufferBacked(shared)

      expect([...normalized]).toEqual([9, 8, 7, 6])
      expect(normalized.buffer).toBeInstanceOf(ArrayBuffer)
      expect(normalized.buffer).not.toBe(shared.buffer)

      // The snapshot is stable: later mutation of the shared buffer must not leak in.
      shared[0] = 0
      expect([...normalized]).toEqual([9, 8, 7, 6])
    })
  })
})
