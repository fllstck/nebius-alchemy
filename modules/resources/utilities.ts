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

/**
 * `specDeepEqual`, but only for the fields `desired` actually **pins**.
 *
 * For an API with **no `FieldMask`** and server-side defaulting, a whole-message
 * comparison cannot converge. There are two reasons, and both are measured rather
 * than hypothetical:
 *
 *   1. **An omitted field is not "clear it"** — proto3 scalars have no presence, so
 *      `""`/`0` and "absent" are the same bytes. Comparing an omitted prop against a
 *      live value is drift on every reconcile, forever (AGENTS.md §Convergence).
 *   2. **The platform materializes defaults into the message it echoes** — the pools of
 *      `vpc/v1 Network`, `transfer.limiters`, `Pool.cidrs[].state`, and (a risk this helper
 *      is what makes harmless rather than a bet) mk8s `template.maxPods`, which the proto
 *      documents as defaulting to `110` — so `specDeepEqual(live, desired)` can never match
 *      when the caller pinned nothing there.
 *
 * So compare only what the caller pinned: a key present in `desired` is compared (with
 * {@link specDeepEqual} at the leaves, so int64s stay visible), and a key absent from
 * `desired` is ignored entirely. An **empty object** is the exception — it is how a
 * presence-only switch is expressed (`publicIpAddress: {}`, `preemptible: {}`), so it
 * compares *presence* rather than nothing. Arrays compare element-wise and must have
 * the same length: an array element's identity is its index (the second network
 * interface really is a different interface).
 *
 * ```ts
 * // props pinned only the size; the API also echoed a default `blockSizeBytes`
 * pinnedSpecDeepEqual(
 *   { sizeGibibytes: 64, blockSizeBytes: 4096 },
 *   { sizeGibibytes: 64 },
 * ) // true — `blockSizeBytes` is not ours to compare
 * ```
 *
 * The cost of the rule is that a prop *missing from `desired`* is also missing from the
 * drift list — which is exactly what the convergence sweep exists to catch: every prop
 * must be planned by `diff` or written by `reconcile`, so a prop that reaches neither
 * fails `tests/convergence-coverage.test.ts` / the table's completeness check.
 */
export const pinnedSpecDeepEqual = (live: unknown, desired: unknown): boolean => {
  // Nothing pinned at this path: whatever the platform holds is not ours to compare.
  if (desired === undefined) return true

  // A leaf (string, number, boolean, Long, …) — `specDeepEqual` normalizes Longs, and
  // treats the class instances it cannot walk as `undefined`, which is its documented
  // behaviour and not ours to reinterpret.
  if (desired === null || typeof desired !== 'object' || Long.isLong(desired)) return specDeepEqual(live, desired)

  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || live.length !== desired.length) return false
    return desired.every((item, index) => pinnedSpecDeepEqual(live[index], item))
  }

  // `desired` is a message. It must be a message live too — a scalar there is a real
  // shape change, not an unpinned field.
  if (live === null || live === undefined || typeof live !== 'object' || Array.isArray(live)) return false

  const desiredMessage = desired as Record<string, unknown>
  const liveMessage = live as Record<string, unknown>
  const pinnedKeys = Object.keys(desiredMessage)

  // An empty message is a presence switch, not an empty comparison: `{}` means "create
  // it", so `undefined` live is drift. (`toEqual({})` would have said "no difference".)
  if (pinnedKeys.length === 0) return live !== undefined && live !== null

  return pinnedKeys.every((key) => pinnedSpecDeepEqual(liveMessage[key], desiredMessage[key]))
}

/**
 * The pin side of {@link pinnedSpecDeepEqual}: drop the fields nobody set.
 *
 * A message built with ts-proto's `fromJSON`/`fromPartial` carries a value for **every**
 * scalar field — `os: ""`, `type: 0`, `maxPods: Long.ZERO` — whether or not the caller
 * set one, so `Object.keys(desired)` is not the pin set. This strips the proto3 defaults
 * (`""`, `0`, `false`, `Long.ZERO`, an empty array, `undefined`) recursively and leaves
 * everything else.
 *
 * **An empty object survives** — that is the one shape where absence and emptiness differ:
 * ts-proto leaves an unset *message* field `undefined`, while a set-but-empty message
 * decodes as `{}`, which is exactly how a presence-only switch is expressed
 * (`publicIpAddress: {}`, `preemptible: {}`).
 *
 * A pinned value that happens to *equal* a proto default would be dropped too, so this is
 * only safe together with props filters that reject those values — which is what the
 * `isNonEmptyString`/`≥ 1`/enum filters on the mk8s template do (`fixedNodeCount: 0`,
 * `os: ""` and `bootDisk.type: 0` are plan-time errors, not silent no-ops).
 */
export const protoPinnedFields = <T>(message: T): T => {
  const cleaned = cleanProtoDefaults(message)
  return (cleaned === undefined ? {} : cleaned) as T
}

/** Is this a proto3 default, i.e. a value that is indistinguishable from an absent field? */
const isProtoDefault = (value: unknown): boolean => {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value === ''
  if (typeof value === 'number') return value === 0
  if (typeof value === 'boolean') return value === false
  if (Long.isLong(value)) return value.isZero()
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** Recursive worker for {@link protoPinnedFields}; returns `undefined` for a dropped value. */
const cleanProtoDefaults = (value: unknown): unknown => {
  if (isProtoDefault(value)) return undefined
  if (Long.isLong(value)) return value
  if (Array.isArray(value)) return value.map(cleanProtoDefaults)
  if (typeof value === 'object') {
    // Class instances are left untouched: `specDeepEqual` owns how they compare, and
    // walking them here is the very hazard `deepEqual`'s rule exists for.
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, cleanProtoDefaults(nested)] as const)
      .filter(([, nested]) => nested !== undefined)
    return Object.fromEntries(entries)
  }
  return value
}

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
