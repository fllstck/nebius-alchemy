import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import * as ComputeGrpc from '../../../../modules/api-client/compute.ts'
import * as NebiusFilesystemSchema from '../../../../schemas/nebius/compute/v1/filesystem.ts'

/**
 * Was `skipIf(true)` with the reason "requires paid tier — quota unavailable for
 * trial accounts", recorded only in the test NAME. Re-tried 2026-09-10 against the
 * live project: it passes (4 GiB NETWORK_SSD filesystem), so that constraint no
 * longer applies. If it regresses with a quota error, record the reason as a
 * comment here — not just in the name.
 */
integrationTest(
  test.provider,
  'Nebius.compute.v1.Filesystem lifecycle',
  (stack) =>
  Effect.gen(function* () {
    const fs = yield* stack.deploy(
      Nebius.compute.Filesystem('LifecycleTest', {
        type: 'NETWORK_SSD',
        sizeGibibytes: 4,
      }),
    )

    expect(fs.id).toBeDefined()
    expect(typeof fs.id).toBe('string')
    expect(fs.name).toBeDefined()
    expect(fs.type).toBe('NETWORK_SSD')
    expect(fs.state).toBe('READY')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 180_000 },
)

// ---------------------------------------------------------------------------
// Update path — TASKS.md §"What is left" A.
//
// `blockSizeBytes` is immutable after creation, which puts it in the replace class — but the
// prop is OPTIONAL while the wire field is not (default 4096), so the drift list mirrors the
// live value when the prop is omitted instead of comparing the prop's zero value against the
// platform default. Both directions are probed live here:
//
//   1. created without the prop → `resourceVersion` 1 (no self-update) and:
//      `spec.blockSizeBytes` is **0/unset** — the platform does NOT echo its 4096 default into
//      the spec (it reports the effective value in `status.blockSizeBytes`, which is what the
//      friendly attributes surface). So the only thing the drift mirror must guarantee is that
//      an omitted prop never drives a write;
//   2. a props change that does NOT touch the spec (`forbidDeletion: false`) → the framework
//      plans an update, reconcile runs, and the mirrored comparison must write NOTHING;
//   3. pinning a different block size → a REPLACE (new id, new generated name), because the
//      API refuses the in-place change — probed directly against `FilesystemService/Update`,
//      not assumed from the docs;
//   4. after that rejection the live spec and version are untouched (no partial application).

/** `blockSizeBytes` is under test; `forbidDeletion` forces a reconcile without a spec change. */
const declareBlockSizeFilesystem = (props: {
  blockSizeBytes?: number
  forbidDeletion?: boolean
}) =>
  Effect.gen(function* (){
    const fs = yield* Nebius.compute.Filesystem('FsBlockSize', {
      type: 'NETWORK_SSD',
      sizeGibibytes: 4,
      ...(props.blockSizeBytes === undefined ? {} : { blockSizeBytes: props.blockSizeBytes }),
      ...(props.forbidDeletion === undefined ? {} : { forbidDeletion: props.forbidDeletion }),
    })
    return fs
  })

integrationTest(
  test.provider,
  'Nebius.compute.v1.Filesystem — blockSizeBytes: mirrored when omitted, replace when pinned',
  (stack) =>
    Effect.gen(function* () {
      const svc = yield* ComputeGrpc.ComputeGrpcService
      const live = (id: string) =>
        svc.filesystem.get(id).pipe(
          Effect.map((raw) => ({
            blockSizeBytes: Number(raw.spec!.blockSizeBytes),
            effectiveBlockSizeBytes: Number(raw.status!.blockSizeBytes),
            version: raw.metadata!.resourceVersion.toString(),
            spec: raw.spec!,
            metadata: raw.metadata!,
          })),
        )

      // 1. Create WITHOUT the prop: `spec` stays unset while `status` reports the effective
      //    default, and the friendly attributes (spec+status merged) surface the status value.
      const created = yield* stack.deploy(declareBlockSizeFilesystem({}))
      const afterCreate = yield* live(created.id)
      console.log(
        `PROBE fs blockSizeBytes: spec=${afterCreate.blockSizeBytes} status=${afterCreate.effectiveBlockSizeBytes} attribute=${created.blockSizeBytes} version=${afterCreate.version}`,
      )
      expect(afterCreate.blockSizeBytes).toBe(0)
      expect(afterCreate.effectiveBlockSizeBytes).toBe(4096)
      // NOTE: the friendly attribute is the int64-to-string echo from `spec.toJSON`, so the
      // attribute the schema types as `Finite` actually arrives as `"4096"` — compare numerically.
      expect(Number(created.blockSizeBytes)).toBe(4096)
      expect(afterCreate.version).toBe('1')

      // 2. Force reconcile without a spec change — the mirror must keep it a no-op.
      const forced = yield* stack.deploy(declareBlockSizeFilesystem({ forbidDeletion: false }))
      const afterForced = yield* live(created.id)
      expect(forced.id).toBe(created.id)
      expect(afterForced.version).toBe(afterCreate.version)

      // 3. Pin a larger block size: `diff` plans a replace, so the generation is new.
      const replaced = yield* stack.deploy(declareBlockSizeFilesystem({ blockSizeBytes: 8192 }))
      const afterReplace = yield* live(replaced.id)
      expect(replaced.id).not.toBe(created.id)
      expect(replaced.name).not.toBe(created.name)
      expect(afterReplace.blockSizeBytes).toBe(8192)
      expect(afterReplace.effectiveBlockSizeBytes).toBe(8192)
      expect(Number(replaced.blockSizeBytes)).toBe(8192)
      expect(afterReplace.version).toBe('1')
      console.log(
        `PROBE fs blockSizeBytes: replace accepted, ${created.id} → ${replaced.id} blockSizeBytes=${afterReplace.blockSizeBytes}`,
      )

      // 4. The API's own answer to an in-place change — the reason for the replace plan.
      //    (`FilesystemSpec.toJSON` is typed `unknown`, so the spec is rebuilt field by field;
      //    the generated `fromJSON` accepts both the numeric enum and its name.)
      const bumped = NebiusFilesystemSchema.FilesystemSpec.fromJSON({
        sizeGibibytes: afterReplace.spec.sizeGibibytes?.toString(),
        blockSizeBytes: '16384',
        type: afterReplace.spec.type,
        forbidDeletion: afterReplace.spec.forbidDeletion,
      })
      const rejected = yield* svc.filesystem
        .update({
          metadata: {
            id: afterReplace.metadata.id,
            resourceVersion: afterReplace.metadata.resourceVersion.toString(),
          },
          spec: bumped,
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag('GrpcError', (e) => {
            console.log(`PROBE fs in-place blockSizeBytes update rejected: code=${e.code} ${e.message}`)
            return Effect.succeed(true)
          }),
        )
      expect(rejected).toBe(true)

      const afterRejection = yield* live(replaced.id)
      expect(afterRejection.blockSizeBytes).toBe(8192)
      expect(afterRejection.version).toBe(afterReplace.version)    }).pipe(
      safeDestroy(stack),
    ),
  { timeout: 300_000 },
)
