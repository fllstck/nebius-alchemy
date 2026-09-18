/**
 * Payload normalization for `s3-lite-client`'s `putObject`.
 *
 * `s3-lite-client` 1.0 narrowed `putObject`'s (and `makeRequest`'s) payload parameter
 * from a bare `Uint8Array` to its own `Uint8Array_` alias,
 * `ReturnType<Uint8Array["slice"]>` — which the current TS lib resolves to
 * `Uint8Array<ArrayBuffer>`. A `Uint8Array<ArrayBufferLike>` (what a bare `Uint8Array`
 * means since TS 5.7) is *not* assignable to that, so any payload crossing the
 * boundary must be normalized first. Note this made the parameter **stricter**, not
 * looser: `Uint8Array<ArrayBufferLike>` is the more general of the two.
 *
 * This is a type-level narrowing only, so it must never change *which bytes* are sent:
 *
 * - `ArrayBuffer`-backed (the common case) — re-viewed in place, no copy. `byteOffset`
 *   and `byteLength` are carried over, so an offset view still uploads exactly its own
 *   bytes and nothing either side of it.
 * - `SharedArrayBuffer`-backed — copied into a private `ArrayBuffer`. A shared buffer
 *   can be mutated by another thread while the request body is being read, and S3
 *   uploads must be a stable snapshot.
 */
export const asArrayBufferBacked = (bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes)
