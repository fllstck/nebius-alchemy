/**
 * Update-path probe for `Nebius.storage.v1.Transfer` — TASKS.md §"What is left" A.
 *
 * `stopCondition` never reached the wire before 2026-09-21: the proto has no
 * `stopCondition` message (it models the union as three flat oneof fields —
 * `afterOneIteration`, `afterNEmptyIterations`, `infinite`) and the old code passed the
 * prop straight into `TransferSpec.fromJSON`, which silently dropped the unknown key.
 * The transfer therefore ran with the server's default stop behaviour on create AND update,
 * and once the API echoed a real stop condition every reconcile drifted.
 *
 * The unit-level sweep row only proves that *something* was written (`writes.length > 0`),
 * not that the wire shape is right — so this test reads the live spec back and asserts the
 * flat field, which is the only thing that proves the mapping.
 *
 * It also probes the update path: `stopCondition` is in no `diff` branch, so a change plans an
 * in-place `TransferService/Update` whose payload carries the new flat field (the framework
 * sends the full desired spec). Whether the API ACCEPTS that change is its call — this test
 * records the answer rather than assuming it.
 */
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as StorageGrpc from '../../../../modules/api-client/storage.ts'
import type { TransferProps } from '../../../../modules/resources/storage/v1/transfer.schema.ts'

/** The tenant's default editors group — its `editor` role carries full S3 object access. */
const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m'

const bucketProps = {
  versioningPolicy: 'DISABLED',
  defaultStorageClass: 'STANDARD',
  objectAuditLogging: 'NONE',
  forceStorageClass: false,
} as const

/**
 * The complete desired set for one deploy (the scratch stack DELETES anything absent from a
 * re-plan, so every stage re-declares all of it): two buckets, an SA with the editors grant,
 * an INLINE access key, and the transfer under test.
 */
const declareTransferStack = (region: string, stopCondition: TransferProps['stopCondition']) =>
  Effect.gen(function* () {
    const source = yield* Nebius.storage.Bucket('XferSrc-Bucket', bucketProps)
    const destination = yield* Nebius.storage.Bucket('XferDst-Bucket', bucketProps)
    const sa = yield* Nebius.iam.ServiceAccount('XferSA', { description: 'transfer probe SA' })
    yield* Nebius.iam.GroupMembership('XferMembership', {
      parentId: EDITORS_GROUP_ID as never,
      memberId: sa.id,
    })
    const key = yield* Nebius.iam.AccessKey('XferKey', {
      serviceAccountId: sa.id,
      secretDeliveryMode: 'INLINE',
    })
    const transfer = yield* Nebius.storage.Transfer('Xfer', {
      // The API REQUIRES a source access key for a Nebius source (probed 2026-09-22: without it
      // the create fails with a bare `3 INVALID_ARGUMENT`); one key serves both ends here.
      source: {
        nebius: {
          region,
          bucketName: source.name,
          accessKey: { accessKeyId: key.awsAccessKeyId, secretAccessKey: key.secretAccessKey },
        },
      },
      destination: {
        nebius: {
          region,
          bucketName: destination.name,
          accessKey: { accessKeyId: key.awsAccessKeyId, secretAccessKey: key.secretAccessKey },
        },
      },
      stopCondition,
      overwriteStrategy: 'NEVER',
    })
    return { source, destination, key, transfer }
  })

integrationTest(
  test.provider,
  'Nebius.storage.v1.Transfer — stopCondition reaches the wire and stays converged',
  (stack) =>
    Effect.gen(function* () {
      const region = yield* Config.String('NEBIUS_REGION').pipe(Config.withDefault('eu-north1'))
      const svc = yield* StorageGrpc.StorageGrpcService
      const live = (id: string) =>
        svc.transfer.get(id).pipe(
          Effect.map((raw) => ({
            version: raw.metadata!.resourceVersion.toString(),
            state: raw.status?.state,
            afterOneIteration: raw.spec?.afterOneIteration !== undefined,
            afterNEmptyIterations: raw.spec?.afterNEmptyIterations?.emptyIterationsThreshold,
            infinite: raw.spec?.infinite !== undefined,
            spec: JSON.stringify(raw.spec),
          })),
        )

      // 1. Create with `afterOneIteration` — the flat oneof field must be on the wire.
      const created = yield* stack.deploy(
        declareTransferStack(region, { afterOneIteration: true }),
      )
      const afterCreate = yield* live(created.transfer.id)
      console.log(
        `PROBE transfer stopCondition: state=${afterCreate.state} version=${afterCreate.version} spec=${afterCreate.spec}`,
      )
      expect(afterCreate.afterOneIteration).toBe(true)
      expect(afterCreate.afterNEmptyIterations).toBeUndefined()
      expect(afterCreate.infinite).toBe(false)
      expect(afterCreate.version).toBe('1')

      // 2. Change it — `diff` ignores the prop, so this plans an in-place update that must
      //    carry the new flat field (and clear the old one).
      const changed = yield* stack.deploy(
        declareTransferStack(region, { afterNEmptyIterations: { emptyIterationsThreshold: 3 } }),
      )
      const afterChange = yield* live(created.transfer.id)
      console.log(
        `PROBE transfer stopCondition: update state=${afterChange.state} version=${afterChange.version} spec=${afterChange.spec}`,
      )
      expect(changed.transfer.id).toBe(created.transfer.id)
      expect(afterChange.afterNEmptyIterations).toBe(3)
      expect(afterChange.afterOneIteration).toBe(false)
      expect(afterChange.version).not.toBe(afterCreate.version)
    }).pipe(
      safeDestroy(stack),
    ),
  // Two buckets + an SA/group/key + the transfer: bucket deletes are async and polled.
  { timeout: 420_000 },
)
