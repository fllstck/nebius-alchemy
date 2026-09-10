import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'

const SOURCE_DISK = { type: 'NETWORK_SSD', sizeGibibytes: 4 } as const
const SNAP_DESCRIPTION = 'Alchemy integration test snapshot (image source)'
const IMAGE_DESCRIPTION = 'Alchemy integration test image'

/**
 * Image lifecycle, from a disk snapshot.
 *
 * Was `skipIf(true)`: "Image creation requires a source disk or snapshot
 * (`spec.source` oneof) … too complex for a single lifecycle test." It is not —
 * it is a three-stage chain, and the house staged-deploy pattern exists exactly
 * for that (`agent-patterns/alchemy-test-patterns.md`): each stage re-declares
 * the resources from the previous stage so the re-plan noop-s them instead of
 * deleting them (`DiskSnapshot` and `Image` are immutable; a replace would be
 * rejected). `sourceStorage` (an image from a bucket object) stays uncovered —
 * it needs a bootable image object uploaded first, which no test can synthesize.
 */
integrationTest(
  test.provider,
  'Nebius.compute.v1.Image lifecycle (from a disk snapshot)', (stack) =>
  Effect.gen(function* () {
    // Stage 1 — the source disk. Its id becomes concrete state for stage 2.
    yield* stack.deploy(
      Effect.gen(function* () {
        yield* Nebius.compute.Disk('ImageSrc', SOURCE_DISK)
      }),
    )

    // Stage 2 — snapshot it (re-declare the disk: noop).
    const { snap } = yield* stack.deploy(
      Effect.gen(function* () {
        const disk = yield* Nebius.compute.Disk('ImageSrc', SOURCE_DISK)
        const snap = yield* Nebius.compute.DiskSnapshot('ImageSnap', {
          sourceDiskId: disk.id,
          description: SNAP_DESCRIPTION,
        })
        return { snap }
      }),
    )
    console.log(`[IMAGE] snapshot ready: ${snap.id}`)

    // Stage 3 — image from the snapshot (re-declare both: noops).
    const { image } = yield* stack.deploy(
      Effect.gen(function* () {
        const disk = yield* Nebius.compute.Disk('ImageSrc', SOURCE_DISK)
        const snap = yield* Nebius.compute.DiskSnapshot('ImageSnap', {
          sourceDiskId: disk.id,
          description: SNAP_DESCRIPTION,
        })
        const image = yield* Nebius.compute.Image('LifecycleTest', {
          sourceDiskSnapshotId: snap.id,
          description: IMAGE_DESCRIPTION,
        })
        return { image }
      }),
    )

    expect(image.id).toBeDefined()
    expect(typeof image.id).toBe('string')
    expect(image.description).toBe(IMAGE_DESCRIPTION)
    console.log(`[IMAGE] created: ${image.id}`)
  }).pipe(safeDestroy(stack)),
  { timeout: 900_000 },
)
