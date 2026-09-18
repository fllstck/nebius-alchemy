import Long from 'long'
import * as AlchemyDiff from 'alchemy/Diff'

/**
 * Structural equality for protobuf messages — `AlchemyDiff.deepEqual`, with
 * int64s made visible.
 *
 * `deepEqual` canonicalizes **non-plain objects (class instances) to
 * `undefined`** on purpose: walking Effect/Layer/SDK objects is unsafe (cyclic),
 * and comparing them is meaningless. But `long`'s `Long` *is* a class instance,
 * so:
 *
 * ```ts
 * deepEqual(Long.fromNumber(2), Long.fromNumber(8)) // true — verified
 * ```
 *
 * Every int64 field therefore compares equal to every other int64 for free, and
 * any comparison of a spec that contains one is blind to exactly the fields users
 * change most: disk sizes, filesystem sizes, quota limits, key rotation periods.
 * Worse, the blindness is *nested* — a Long anywhere inside (e.g. inside a
 * `google.protobuf.Duration`, or inside `AttachedDiskSpec.managedDisk.spec`)
 * makes that leaf invisible while its siblings still compare.
 *
 * This normalizes Longs to their decimal string first (also the JSON form the API
 * uses), then delegates the rest of the comparison to `deepEqual`, so key-order
 * insensitivity and the non-plain-object rules are unchanged. Use it for **every**
 * comparison of a proto message or resource:
 *
 * ```ts
 * if (live.spec && !specDeepEqual(live.spec, desired)) { ...update... }
 * ```
 */
export const specDeepEqual = (a: unknown, b: unknown): boolean =>
  AlchemyDiff.deepEqual(normalizeLongs(a), normalizeLongs(b))

/** Replace every `Long` (at any depth, in objects and arrays) with its decimal string. */
const normalizeLongs = (value: unknown): unknown => {
  if (Long.isLong(value)) return value.toString()
  if (Array.isArray(value)) return value.map(normalizeLongs)
  if (value !== null && typeof value === 'object') {
    // Only walk plain objects. Anything else is left for `deepEqual` to treat as
    // it always has (absent) — we must not start walking class instances here,
    // which is the very hazard that rule exists for.
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeLongs(nested)]))
  }
  return value
}

/**
 * Convert a protobuf resource (metadata + spec + status) into friendly
 * attributes by merging raw fields with their JSON-serialized equivalents.
 *
 * The raw spread ensures no fields are dropped. The JSON overlay converts
 * Long → string and enum → string. Optional overrides handle edge cases
 * like Long.ZERO which `toJSON` conditionally omits.
 */
export const toFriendlyAttributes = <T>({
  rawResource,
  resourceSchema,
  overrides,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawResource: { metadata?: any; spec?: any; status?: any }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resourceSchema: { toJSON: (resource: any) => any }
  overrides?: Record<string, unknown>
}): T => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const safeResource = resourceSchema.toJSON(rawResource)
  return {
    ...rawResource.metadata,
    ...rawResource.spec,
    ...rawResource.status,
    ...safeResource.metadata,
    ...safeResource.spec,
    ...safeResource.status,
    ...overrides,
  } as T
}
