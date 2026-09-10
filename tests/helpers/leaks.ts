/**
 * Post-destroy leak verification for integration tests.
 *
 * ## Why this is not a simple "is it still listed?" check
 *
 * Nebius deletes are **asynchronous and soft**: the delete RPC returns as soon
 * as the request is accepted, but the resource stays visible in `list` in a
 * deletion-pending state for minutes afterwards, until the platform reaps it.
 * An assertion that treats "still listed" as "leaked" therefore races the reap
 * and fails spuriously.
 *
 * Observed live (2026-09-10, `eu-north1`): `Nebius.storage.v1.Bucket`'s delete
 * returned in **149 ms**, and the bucket then sat in `SCHEDULED_FOR_DELETION`
 * for roughly **6 minutes** before disappearing. Three storage integration
 * tests failed on exactly this — reporting a leak that never existed and
 * leaving nothing behind. (See `agent-patterns/alchemy-test-patterns.md`.)
 *
 * So: only a resource that is still **live** counts as leaked. A resource whose
 * deletion has been accepted is cleanup *in progress*, not a leak.
 *
 * This complements `cleanup.ts`'s `safeDestroy`, which decides *whether* to
 * verify; this module decides *what counts as verified*.
 */
import * as Effect from 'effect/Effect'
import type { Bucket } from '../../schemas/nebius/storage/v1/bucket.ts'
import { BucketStatus_State } from '../../schemas/nebius/storage/v1/bucket.ts'
import * as StorageGrpc from '../../modules/api-client/storage.ts'

/**
 * True when the platform has accepted this bucket for deletion but has not yet
 * reaped it. Both signals are checked because they are set independently:
 * `state` moves to `SCHEDULED_FOR_DELETION`, and `deletedAt` carries the
 * soft-delete timestamp (it resets to null if the bucket is undeleted).
 */
const isDeletionPending = (bucket: Bucket): boolean =>
  bucket.status?.state === BucketStatus_State.SCHEDULED_FOR_DELETION ||
  bucket.status?.deletedAt != null

/**
 * Fail if any bucket matching `prefix` is still live under `parentId`.
 *
 * Pass the same project the test deployed into — pointing `parentId` at a
 * different project silently blinds the check, since it would then list an
 * empty, unrelated scope.
 *
 * Usage (as the `verify` argument to `safeDestroy`):
 *
 *   }).pipe(safeDestroy(stack, verifyNoBucketLeaks(PROJECT)))
 */
export const verifyNoBucketLeaks = Effect.fn('verifyNoBucketLeaks')(function* (
  parentId: string,
  prefix = 'nebius-storage-',
) {
  const storage = yield* StorageGrpc.StorageGrpcService
  const buckets = yield* storage.bucket.list(parentId)
  const leaked = buckets.filter(
    (bucket) =>
      bucket.metadata?.name?.startsWith(prefix) === true &&
      !isDeletionPending(bucket),
  )
  if (leaked.length > 0) {
    return yield* Effect.fail(
      new Error(
        `LEAKED buckets after destroy: ${leaked
          .map((bucket) => `${bucket.metadata?.name} (state=${bucket.status?.state})`)
          .join(', ')}`,
      ),
    )
  }
})
