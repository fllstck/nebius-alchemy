import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusDiskSnapshotSchema from '../../../../schemas/nebius/compute/v1/disk_snapshot.ts'
import * as ComputeGrpc from '../../../api-client/compute.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as DiskSnapshotSchema from './disk-snapshot.schema.ts'
import * as Factory from '../../factory.ts'
import * as IamGrpc from '../../../api-client/iam.ts'

// ----- RESOURCE TYPES

export type NebiusDiskSnapshot = Alchemy.Resource<
  'Nebius.compute.v1.DiskSnapshot',
  DiskSnapshotSchema.DiskSnapshotProps,
  DiskSnapshotSchema.DiskSnapshotAttributes
>

export const NebiusDiskSnapshot = Alchemy.Resource<NebiusDiskSnapshot>('Nebius.compute.v1.DiskSnapshot')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusDiskSnapshotSchema.DiskSnapshot,
): DiskSnapshotSchema.DiskSnapshotAttributes =>
  ResourceUtils.toFriendlyAttributes<DiskSnapshotSchema.DiskSnapshotAttributes>({
    rawResource: raw,
    resourceSchema: NebiusDiskSnapshotSchema.DiskSnapshot,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusDiskSnapshotProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusDiskSnapshot>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusDiskSnapshot>, never, any>)
  : AlchemyProvider.succeed(NebiusDiskSnapshot, {
  reconcile: Effect.fn('Nebius.compute.v1.DiskSnapshot.reconcile')(function* ({ id, news, output, session }) {
    news = yield* DiskSnapshotSchema.validateDiskSnapshotProps(news)

    const svc = yield* ComputeGrpc.ComputeGrpcService

    let snap: NebiusDiskSnapshotSchema.DiskSnapshot | undefined
    if (output?.id) {
      snap = yield* svc.diskSnapshot
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
    if (!snap) {
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.compute.v1.DiskSnapshot (${name})`)
      snap = yield* svc.diskSnapshot.create({
        metadata: { parentId, name, labels },
        spec: NebiusDiskSnapshotSchema.DiskSnapshotSpec.fromJSON({
          sourceDiskId: news.sourceDiskId,
          description: news.description || '',
        }),
      })
    }

    const desired = NebiusDiskSnapshotSchema.DiskSnapshotSpec.fromJSON({
      sourceDiskId: news.sourceDiskId,
      description: news.description || '',
    })
    if (snap.spec && !AlchemyDiff.deepEqual(snap.spec, desired)) {
      yield* session.note(`Updating Nebius.compute.v1.DiskSnapshot (${snap.metadata!.name})`)
      snap = yield* svc.diskSnapshot.update({
        metadata: {
          id: snap.metadata!.id,
          parentId,
          resourceVersion: snap.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(snap)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.compute.v1.DiskSnapshot',
    resourceLabel: 'DiskSnapshot',
    service: ComputeGrpc.ComputeGrpcService,
    deleteById: (svc, id) => svc.diskSnapshot.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.compute.v1.DiskSnapshot',
    service: ComputeGrpc.ComputeGrpcService,
    getById: (svc, id) => svc.diskSnapshot.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.compute.v1.DiskSnapshot',
    service: ComputeGrpc.ComputeGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (project) => project.metadata!.id,
    listByParent: (svc, parentId) => svc.diskSnapshot.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.compute.v1.DiskSnapshot.diff')(function* ({ news, olds }) {
    news = news || ({} as DiskSnapshotSchema.DiskSnapshotProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    // sourceDiskId is immutable
    if (news.sourceDiskId !== olds?.sourceDiskId) return { action: 'replace' }
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
