import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
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

    if (!transfer) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

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
      if (news.touchUnmanaged != null) spec.touchUnmanaged = news.touchUnmanaged

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
    if (news.limiters) desiredSpec.limiters = news.limiters
    if (news.interIterationIntervalSeconds != null)
      desiredSpec.interIterationInterval = { seconds: String(news.interIterationIntervalSeconds) }
    if (news.enableDeletesInDestination != null)
      desiredSpec.enableDeletesInDestination = news.enableDeletesInDestination
    if (news.touchUnmanaged != null) desiredSpec.touchUnmanaged = news.touchUnmanaged

    const desired = NebiusTransferSchema.TransferSpec.fromJSON(desiredSpec)
    // `specDeepEqual`: `interIterationInterval` is a `Duration` (Long seconds) and
    // the limiters carry int64s — invisible to `deepEqual` (see utilities.ts).
    if (transfer.spec && !ResourceUtils.specDeepEqual(transfer.spec, desired)) {
      yield* session.note(`Updating Nebius.storage.v1.Transfer (${transfer.metadata!.name})`)
      transfer = yield* svc.transfer.update({
        metadata: {
          id: transfer.metadata!.id,
          resourceVersion: transfer.metadata!.resourceVersion.toString(),
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
    // Delete — the API handles stopping if still active
    yield* svc.transfer.delete(output.id)
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
    if (news.source !== olds?.source) return Factory.replaceKeepingName(news)
    if (news.destination !== olds?.destination) return Factory.replaceKeepingName(news)
    if (news.overwriteStrategy !== olds?.overwriteStrategy) return Factory.replaceKeepingName(news)
    return Factory.identityChangeRequiresReplace(news, olds)
  }),
})
