/**
 * The **live-echo oracle** — TASKS.md §"What is left" E.
 *
 * Every mock in the convergence sweep builds its `live` fixture from the same props the provider
 * sends, so the sweep can only ever assert "the API echoes what I sent". The API does not: it
 * fills in defaults (`vpc/v1/{network,subnet}` pool structs, `transfer.limiters` +
 * `interIterationInterval`), never echoes write-only secrets (`transfer.secretAccessKey`), and
 * reports effective values in `status` (`filesystem.blockSizeBytes`). Each of those was found live.
 *
 * `metadata.resourceVersion` is the wire evidence: the API bumps it on an accepted write. Two
 * assertions fall out of it, and **both** are needed because they catch different halves:
 *
 * 1. **After a create-only deploy the version must be `1`.** A larger value means reconcile issued
 *    a second write against the API's own create echo. This is what caught the `vpc/v1/subnet`
 *    pool-struct bug (version 2 for a single create).
 * 2. **A reconcile that was planned as an update but should write nothing must not move it.**
 *    An identical re-deploy is a `noop` plan — reconcile never runs — so the probe needs a props
 *    change the `diff` ignores and the drift list does not care about (`labels` is the fleet-wide
 *    one; AGENTS.md §Convergence classifies it create-time-only). This is the direction that made
 *    `record.ttl`, `zone.soaSpec`, `filesystem.blockSizeBytes` and
 *    `transfer.{limiters,interIterationInterval}` unsafe, and assertion 1 alone cannot see it.
 *
 * ## Calibration: `resourceVersion` is NOT always a per-resource write counter (measured 2026-09-22)
 *
 * | resource type | create-only value | meaning |
 * | `vpc/v1/{Subnet,RouteTable,SecurityGroup,Pool}`, `compute/v1/{Disk,Filesystem,GpuCluster}`, `storage/v1/Transfer` | `1` | a per-resource counter → assertion 1 is meaningful |
 * | `vpc/v1/SecurityRule` | `5`, then stable | an opaque/platform-side sequence (the platform writes the rule into dataplane state during creation; the spec echo is already identical to `desired`) |
 * | `dns/v1/Record` | `661134` | opaque, epoch-like |
 * | `vpc/v1/Network` | moves while idle | the platform assigns real `vpcpool-` ids into `spec` itself |
 *
 * So a non-`1` value is *either* our bug *or* a different version scheme, and only a human can tell
 * them apart. {@link calibrateCreates} therefore: settles each version (read → 3 s → read, so a
 * platform writing underneath us is detected rather than misread), asserts `1` where the type is
 * known to count per resource, accepts the documented non-counters in {@link NOT_A_WRITE_COUNTER}
 * (**with the measurement that justified the entry**), and FAILS on anything new — forcing the next
 * reader to decide instead of the audit quietly rotting into log-only.
 */
import * as Effect from 'effect/Effect'

/** The raw message shape every Nebius resource shares: `metadata.resourceVersion` + `spec`. */
export interface ProtoResource {
  readonly metadata?: { readonly resourceVersion?: unknown } | undefined
  readonly spec?: unknown
}

export interface LiveEchoTarget {
  /** Human label for the run log, e.g. `vpc/v1 Subnet`. */
  readonly label: string
  /** Read the raw resource (the api-client's `get`) — the version is read from it. */
  readonly get: Effect.Effect<ProtoResource, unknown>
}

interface Calibration {
  /** The settled version after the create-only deploy. */
  readonly version: string
  /** Assert it does not move across the forced reconcile (`false` when the platform moves it). */
  readonly assertStable: boolean
  /** The type's version is a per-resource counter and the create wrote exactly once. */
  readonly singleWrite: boolean
}

export type Calibrations = ReadonlyMap<string, Calibration>

/**
 * Types whose `resourceVersion` is NOT a per-resource write counter, with the measurement that
 * justified the entry (re-measure, never trust the prose):
 */
const NOT_A_WRITE_COUNTER: Record<string, string> = {
  'vpc/v1 SecurityRule':
    'create-only version 5, then stable across 3 s idle + an identical re-deploy + a forced reconcile; the spec echo is already identical to desired, so nothing of ours wrote again (measured 2026-09-22)',
  'dns/v1 Record':
    'opaque epoch-like base (661134 observed 2026-09-22) rather than a counter starting at 1; it does bump on a real update',
  'dns/v1 Zone':
    'opaque base (200740 observed 2026-09-22) rather than a counter starting at 1; the forced-reconcile assertion stays meaningful because a real update bumps it — measured by the `negativeTtl` step of the dns family test',
  'vpc/v1 Network':
    'the platform assigns real vpcpool- ids into spec on its own, so the version climbs without any write of ours (4 observed after a create with zero updates from us, 2026-09-22)',
}

/** How long to watch a version for platform-side writes before trusting it. */
const SETTLE_MS = 3_000

/** Read a resource's `resourceVersion` (exported for the real-update calibration in the tests). */
export const readVersion = <A extends ProtoResource>(get: Effect.Effect<A, unknown>): Effect.Effect<string, unknown> =>
  Effect.map(get, (raw) => String(raw.metadata?.resourceVersion))

const versionOf = readVersion

const readAll = (
  targets: ReadonlyArray<LiveEchoTarget>,
): Effect.Effect<ReadonlyMap<string, string>, unknown> =>
  Effect.gen(function* () {
    const rows = yield* Effect.forEach(targets, (target) =>
      Effect.map(versionOf(target.get), (version) => [target.label, version] as const),
    )
    return new Map(rows)
  })

/**
 * Classify every resource of a family right after its create-only deploy: settle the versions,
 * assert `1` where a per-resource counter is expected, and return the settled values for the
 * forced-reconcile assertion. Fails loudly on an undocumented non-`1` (see the module doc).
 */
export const calibrateCreates = (
  targets: ReadonlyArray<LiveEchoTarget>,
): Effect.Effect<Calibrations, unknown> =>
  Effect.gen(function* () {
    const first = yield* readAll(targets)
    yield* Effect.sleep(SETTLE_MS)
    const settled = yield* readAll(targets)

    const calibrations = new Map<string, Calibration>()
    for (const { label } of targets) {
      const version = settled.get(label) ?? '<unreadable>'
      if (first.get(label) !== version) {
        console.log(
          `LIVE-ECHO ${label}: PLATFORM-VOLATILE — version ${first.get(label)} → ${version} while idle; ` +
            `version assertions skipped (assert the resource's effective spec instead)`,
        )
        calibrations.set(label, { version, assertStable: false, singleWrite: false })
        continue
      }
      if (version === '1') {
        console.log(`LIVE-ECHO ${label}: create-only deploy = exactly one write ✅`)
        calibrations.set(label, { version, assertStable: true, singleWrite: true })
        continue
      }
      if (version === '0' || version === 'undefined') {
        console.log(
          `LIVE-ECHO ${label}: no resourceVersion exposed (${version}) — version assertions skipped; ` +
            `assert the spec echo instead (specSnapshot + expectSpecUnchanged)`,
        )
        calibrations.set(label, { version, assertStable: false, singleWrite: false })
        continue
      }
      const reason = NOT_A_WRITE_COUNTER[label]
      if (reason === undefined)
        return yield* Effect.fail(
          new Error(
            `LIVE-ECHO ${label}: resourceVersion is ${version} after a CREATE-ONLY deploy (expected 1).\n` +
              `  Either reconcile wrote a second time — the drift list disagrees with the API's create echo; fix the\n` +
              `  comparison (news-side guard, mirror the live value, strip write-only fields) and encode the echo in the\n` +
              `  convergence table's live fixture (AGENTS.md §Convergence) —\n` +
              `  or this type's resourceVersion is simply not a per-resource counter: check that the spec echo equals what\n` +
              `  the provider sends (dump it), then add the label to NOT_A_WRITE_COUNTER in tests/helpers/live-echo.ts\n` +
              `  WITH the measurement, so the next run keeps its teeth.`,
          ),
        )
      console.log(`LIVE-ECHO ${label}: version ${version} — documented non-counter (${reason})`)
      calibrations.set(label, { version, assertStable: true, singleWrite: false })
    }
    return calibrations
  })

/**
 * The forced-reconcile assertion: every version must still be the one the create settled on. Only
 * platform-volatile resources are skipped (their test asserts effective values instead).
 */
export const expectNoWrites = (
  calibrations: Calibrations,
  targets: ReadonlyArray<LiveEchoTarget>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const after = yield* readAll(targets)
    for (const { label } of targets) {
      const calibration = calibrations.get(label)
      if (calibration === undefined || !calibration.assertStable) continue
      const version = after.get(label)
      if (version !== calibration.version)
        return yield* Effect.fail(
          new Error(
            `LIVE-ECHO ${label}: resourceVersion moved ${calibration.version} → ${version} across a reconcile that\n` +
              `  was planned as an update and should have written NOTHING. Something in the drift list disagrees with\n` +
              `  the API's own echo (a defaulted/omitted field compared against the platform's value, or a field the\n` +
              `  API never echoes). See AGENTS.md §Convergence.`,
          ),
        )
      console.log(`LIVE-ECHO ${label}: forced reconcile wrote nothing (resourceVersion=${version}) ✅`)
    }
  })

/* ---------------------------------------------------------------------------
 * Fallback oracle for types with no usable counter (`vpc/v1/Network`, the KMS keys): snapshot the
 * spec echo and require it to survive the forced reconcile. Weaker than the version oracle — it
 * cannot see a write that re-sends an identical spec — but it does catch a reconcile clobbering
 * platform-assigned values (the network's `vpcpool-` ids were exactly that, and the KMS keys expose
 * no `resourceVersion` at all: 0).
 * ------------------------------------------------------------------------- */

/** JSON snapshot of the spec echo (int64s render as their canonical decimal string). */
export const specSnapshot = <A extends ProtoResource>(get: Effect.Effect<A, unknown>): Effect.Effect<string, unknown> =>
  Effect.map(get, (raw) => JSON.stringify(raw.spec))

/** The spec echo must be unchanged after the forced reconcile. */
export const expectSpecUnchanged = (
  label: string,
  before: string,
  get: Effect.Effect<ProtoResource, unknown>,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const after = yield* specSnapshot(get)
    if (after !== before)
      return yield* Effect.fail(
        new Error(
          `LIVE-ECHO ${label}: the spec echo changed across a forced reconcile\n  before: ${before}\n  after:  ${after}`,
        ),
      )
    console.log(`LIVE-ECHO ${label}: spec echo survived the forced reconcile ✅ (${before})`)
  })
