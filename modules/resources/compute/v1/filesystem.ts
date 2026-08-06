import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusFilesystemSchema from '../../../../schemas/nebius/compute/v1/filesystem.ts'
import * as ComputeGrpc from '../../../api-client/compute.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as FilesystemSchema from './filesystem.schema.ts'
import * as Factory from '../../factory.ts'
import * as IamGrpc from '../../../api-client/iam.ts'

// ----- RESOURCE TYPES

export type NebiusFilesystem = Alchemy.Resource<
  'Nebius.compute.v1.Filesystem',
  FilesystemSchema.FilesystemProps,
  FilesystemSchema.FilesystemAttributes
>

export const NebiusFilesystem = Alchemy.Resource<NebiusFilesystem>('Nebius.compute.v1.Filesystem')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusFilesystemSchema.Filesystem,
): FilesystemSchema.FilesystemAttributes =>
  ResourceUtils.toFriendlyAttributes<FilesystemSchema.FilesystemAttributes>({
    rawResource: raw,
    resourceSchema: NebiusFilesystemSchema.Filesystem,
  })

// ----- PROVIDER

export const NebiusFilesystemProvider = AlchemyProvider.succeed(NebiusFilesystem, {
  reconcile: Effect.fn('Nebius.compute.v1.Filesystem.reconcile')(function* ({ id, news, output, session }) {
    news = yield* FilesystemSchema.validateFilesystemProps(news)

    const svc = yield* ComputeGrpc.ComputeGrpcService

    let fs: NebiusFilesystemSchema.Filesystem | undefined
    if (output?.id) {
      fs = yield* svc.filesystem
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
    if (!fs) {
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      const spec: Record<string, unknown> = {
        sizeGibibytes: String(news.sizeGibibytes),
        type: news.type,
      }
      if (news.blockSizeBytes) spec.blockSizeBytes = String(news.blockSizeBytes)
      if (news.forbidDeletion) spec.forbidDeletion = true

      yield* session.note(`Creating Nebius.compute.v1.Filesystem (${name})`)
      fs = yield* svc.filesystem.create({
        metadata: { parentId, name, labels },
        spec: NebiusFilesystemSchema.FilesystemSpec.fromJSON(spec),
      })
    }

    const desiredSpec: Record<string, unknown> = {
      sizeGibibytes: String(news.sizeGibibytes),
      type: news.type,
    }
    if (news.blockSizeBytes) desiredSpec.blockSizeBytes = String(news.blockSizeBytes)
    if (news.forbidDeletion) desiredSpec.forbidDeletion = true

    const desired = NebiusFilesystemSchema.FilesystemSpec.fromJSON(desiredSpec)
    if (fs.spec && !AlchemyDiff.deepEqual(fs.spec, desired)) {
      yield* session.note(`Updating Nebius.compute.v1.Filesystem (${fs.metadata!.name})`)
      fs = yield* svc.filesystem.update({
        metadata: {
          id: fs.metadata!.id,
          parentId,
          resourceVersion: fs.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(fs)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.compute.v1.Filesystem',
    resourceLabel: 'Filesystem',
    service: ComputeGrpc.ComputeGrpcService,
    deleteById: (svc, id) => svc.filesystem.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.compute.v1.Filesystem',
    service: ComputeGrpc.ComputeGrpcService,
    getById: (svc, id) => svc.filesystem.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.compute.v1.Filesystem',
    service: ComputeGrpc.ComputeGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (project) => project.metadata!.id,
    listByParent: (svc, parentId) => svc.filesystem.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.compute.v1.Filesystem.diff')(function* ({ news, olds }) {
    news = news || ({} as FilesystemSchema.FilesystemProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    // type is immutable
    if (news.type !== olds?.type) return { action: 'replace' }
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
