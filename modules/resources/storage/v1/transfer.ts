import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusTransferSchema from '../../../../schemas/nebius/storage/v1/transfer.ts'
import * as StorageGrpc from '../../../api-client/storage.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as TransferSchema from './transfer.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

/**
 * The props' `stopCondition` union maps onto three **flat** oneof fields of `TransferSpec`
 * (`afterOneIteration`, `afterNEmptyIterations`, `infinite`) — the proto has no
 * `stopCondition` message. Passing `stopCondition` through (as this did) is silently dropped
 * by `fromJSON`, so the transfer ran with the server's default stop behaviour on create *and*
 * update. Found by the convergence sweep: the prop reached neither the plan nor the write.
 */
const stopConditionFields = (stop: TransferSchema.TransferProps['stopCondition']): Record<string, unknown> => {
  if ('afterOneIteration' in stop) return { afterOneIteration: {} }
  if ('infinite' in stop) return { infinite: {} }
  return {
    afterNEmptyIterations: { emptyIterationsThreshold: stop.afterNEmptyIterations.emptyIterationsThreshold },
  }
}

/** Blank the write-only secret of one credential pair — see {@link withoutCredentials}. */
const blankCredentials = (
  key: NebiusTransferSchema.TransferCredentialsAccessKey | undefined,
): NebiusTransferSchema.TransferCredentialsAccessKey | undefined =>
  key === undefined ? undefined : { ...key, secretAccessKey: '' }

/**
 * Blank every credential-valued field before comparing a spec — `accessKey` objects and the
 * `secretAccessKey` inside them, for every source/destination arm that carries credentials.
 *
 * ⚠️ Live behaviour, probed 2026-09-22: the API **never echoes a secret**. A transfer created
 * with a real destination/source key comes back with `secretAccessKey: ""`, so a whole-spec
 * comparison against `desired` (which carries the real secret) ALWAYS differed and re-sent an
 * update on every reconcile — the transfer's `resourceVersion` was 2 straight after a create
 * that should have written once. Credentials cannot be a drift signal: they are write-only.
 *
 * No convergence is lost by ignoring them here: a change anywhere inside `source`/`destination`
 * (a rotated key included) is planned as a REPLACE by `diff`, so it never reaches this update
 * path.
 *
 * The clone is structural, not a JSON round-trip: `transferSpecDrifted` relies on
 * `specDeepEqual` to normalize int64s, and that only happens while the `Long` instances are
 * still `Long`s (the limiter/interval fields are `uint64`s, so the API's echo differs in the
 * `unsigned` flag from a mirrored JSON zero — an equality `toJSON`-based comparison misses).
 */
export const withoutCredentials = (spec: NebiusTransferSchema.TransferSpec): NebiusTransferSchema.TransferSpec => {
  const clone: NebiusTransferSchema.TransferSpec = { ...spec }

  const source = spec.source
  if (source !== undefined) {
    clone.source = { ...source }
    if (source.nebius !== undefined)
      clone.source.nebius = { ...source.nebius, accessKey: blankCredentials(source.nebius.accessKey) }
    if (source.s3Compatible !== undefined)
      clone.source.s3Compatible = {
        ...source.s3Compatible,
        accessKey: blankCredentials(source.s3Compatible.accessKey),
      }
    if (source.azureBlobStorage !== undefined)
      clone.source.azureBlobStorage = {
        ...source.azureBlobStorage,
        azureStorageAccount:
          source.azureBlobStorage.azureStorageAccount === undefined
            ? undefined
            : { ...source.azureBlobStorage.azureStorageAccount, accessKey: '' },
      }
  }

  const destination = spec.destination
  if (destination !== undefined) {
    clone.destination = { ...destination }
    if (destination.nebius !== undefined)
      clone.destination.nebius = { ...destination.nebius, accessKey: blankCredentials(destination.nebius.accessKey) }
    if (destination.s3Compatible !== undefined)
      clone.destination.s3Compatible = {
        ...destination.s3Compatible,
        accessKey: blankCredentials(destination.s3Compatible.accessKey),
      }
  }

  return clone
}

/** Whole-spec drift check, credentials excluded (see {@link withoutCredentials}). */
export const transferSpecDrifted = (
  current: NebiusTransferSchema.TransferSpec,
  desired: NebiusTransferSchema.TransferSpec,
): boolean => !ResourceUtils.specDeepEqual(withoutCredentials(current), withoutCredentials(desired))

export type NebiusTransfer = Alchemy.Resource<
  'Nebius.storage.v1.Transfer',
  TransferSchema.TransferProps,
  TransferSchema.TransferAttributes
>

export const NebiusTransfer = Alchemy.Resource<NebiusTransfer>('Nebius.storage.v1.Transfer')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusTransferSchema.Transfer,
): TransferSchema.TransferAttributes =>
  ResourceUtils.toFriendlyAttributes<TransferSchema.TransferAttributes>({
    rawResource: raw,
    resourceSchema: NebiusTransferSchema.Transfer,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusTransferProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusTransfer>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusTransfer>, never, any>)
  : AlchemyProvider.succeed(NebiusTransfer, {
  reconcile: Effect.fn('Nebius.storage.v1.Transfer.reconcile')(function* ({ id, news, output, session }) {
    news = yield* TransferSchema.validateTransferProps(news)

    const svc = yield* StorageGrpc.StorageGrpcService

    let transfer: NebiusTransferSchema.Transfer | undefined
    if (output?.id) {
      transfer = yield* svc.transfer
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!transfer) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const spec: Record<string, unknown> = {
        source: news.source,
        destination: news.destination,
        overwriteStrategy: news.overwriteStrategy,
        ...stopConditionFields(news.stopCondition),
      }
      if (news.limiters) spec.limiters = news.limiters
      if (news.interIterationIntervalSeconds != null)
        spec.interIterationInterval = { seconds: String(news.interIterationIntervalSeconds) }
      if (news.enableDeletesInDestination != null)
        spec.enableDeletesInDestination = news.enableDeletesInDestination
      if (news.touchUnmanaged != null)
        spec.touchUnmanaged = news.touchUnmanaged

      yield* session.note(`Creating Nebius.storage.v1.Transfer (${name})`)
      transfer = yield* svc.transfer.create({
        metadata: { parentId, name, labels },
        spec: NebiusTransferSchema.TransferSpec.fromJSON(spec),
      })
    }

    // Update if spec changed
    const desiredSpec: Record<string, unknown> = {
      source: news.source,
      destination: news.destination,
      overwriteStrategy: news.overwriteStrategy,
      ...stopConditionFields(news.stopCondition),
    }
    // The API answers fields the props omit with its OWN defaults — `limiters: {}` (an empty
    // message: bandwidth/requests unset, so the platform limit applies) and
    // `interIterationInterval: 900s`. Those are not in `desired`, so comparing the echoed spec
    // against it re-sent an update on EVERY reconcile and never converged (probed live
    // 2026-09-22, `tests/resources/storage/v1/transfer.integration.test.ts`). Mirror the live
    // value into `desired` when the prop is omitted, exactly as `filesystem.blockSizeBytes`
    // does — "omitted" then means "leave whatever the platform has" instead of "reset it".
    if (news.limiters) desiredSpec.limiters = news.limiters
    else if (transfer.spec?.limiters !== undefined)
      desiredSpec.limiters = {
        bandwidthBytesPerSecond: transfer.spec.limiters.bandwidthBytesPerSecond.toString(),
        requestsPerSecond: transfer.spec.limiters.requestsPerSecond.toString(),
      }
    if (news.interIterationIntervalSeconds != null)
      desiredSpec.interIterationInterval = { seconds: String(news.interIterationIntervalSeconds) }
    else if (transfer.spec?.interIterationInterval !== undefined)
      desiredSpec.interIterationInterval = { seconds: transfer.spec.interIterationInterval.seconds.toString() }
    if (news.enableDeletesInDestination != null)
      desiredSpec.enableDeletesInDestination = news.enableDeletesInDestination
    if (news.touchUnmanaged != null) desiredSpec.touchUnmanaged = news.touchUnmanaged

    const desired = NebiusTransferSchema.TransferSpec.fromJSON(desiredSpec)
    // `transferSpecDrifted`: the API echoes `secretAccessKey: ""` (write-only), so credentials
    // are stripped before comparing; `interIterationInterval` is a `Duration` (Long seconds)
    // and the limiters carry int64s — invisible to `deepEqual` (see utilities.ts).
    if (transfer.spec && transferSpecDrifted(transfer.spec, desired)) {
      yield* session.note(`Updating Nebius.storage.v1.Transfer (${transfer.metadata!.name})`)
      transfer = yield* svc.transfer.update({
        metadata: {
          id: transfer.metadata!.id,
          resourceVersion: transfer.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(transfer)
  }),

  delete: Effect.fn('Nebius.storage.v1.Transfer.delete')(function* ({ output, session }) {
    const svc = yield* StorageGrpc.StorageGrpcService
    yield* session.note(`Deleting Transfer (${output.id})`)
    // Fetch current state to check if transfer is active
    const transfer = yield* svc.transfer
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    // If active, stop before deleting
    if (transfer && transfer.status?.state === 1 /* ACTIVE */) {
      yield* svc.transfer.stop(output.id).pipe(
        Effect.catchTag('GrpcError', () => Effect.succeed(undefined)),
      )
    }
    // Delete — the API handles stopping if still active.
    //
    // NOT_FOUND is success, exactly as in `makeCrudDelete`: the transfer may already be gone
    // (cascaded away, or deleted by hand). Treating it as a failure is not cosmetic — a create
    // that failed left a state row behind and the delete then failed, which BLOCKED the whole
    // destroy plan (`Skipping delete — blocked by failed delete of Xfer`) and leaked the two
    // buckets, the service account and the access key it depended on (observed live
    // 2026-09-22). Idempotent deletes are the documented contract (AGENTS.md,
    // agent-patterns/alchemy-test-patterns.md).
    yield* svc.transfer.delete(output.id).pipe(
      Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.void : Effect.fail(e))),
    )
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.storage.v1.Transfer',
    validate: TransferSchema.validateTransferProps,
    service: StorageGrpc.StorageGrpcService,
    getById: (svc, id) => svc.transfer.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.storage.v1.Transfer',
    service: StorageGrpc.StorageGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (project) => project.metadata!.id,
    listByParent: (svc, parentId) => svc.transfer.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.storage.v1.Transfer.diff')(function* ({ news, olds }) {
    news = news || ({} as TransferSchema.TransferProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* TransferSchema.validateTransferProps(news)
    // ⚠️ Compare STRUCTURALLY, never by reference: `news.source` is a freshly built config object
    // and `olds.source` comes back from the state store, so `news.source !== olds.source` is true
    // on every single apply — an unchanged config then plans a replace, and because the old
    // transfer still holds the destination (`Factory.replaceKeepingName` → create-first) the
    // replacement dies with `6 ALREADY_EXISTS: Transfer with overlapping destination exists`.
    // Found live 2026-09-22; pinned by the sweep's
    // "baseline plans no change against structurally identical props" row.
    if (!ResourceUtils.specDeepEqual(news.source, olds?.source)) return Factory.replaceKeepingName(news)
    if (!ResourceUtils.specDeepEqual(news.destination, olds?.destination))
      return Factory.replaceKeepingName(news)
    if (news.overwriteStrategy !== olds?.overwriteStrategy) return Factory.replaceKeepingName(news)
    return Factory.identityChangeRequiresReplace(news, olds)
  }),
})
