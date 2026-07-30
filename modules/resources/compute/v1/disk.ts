import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusDiskSchema from '../../../../schemas/nebius/compute/v1/disk'
import * as IamGrpc from '../../../api-client/iam'
import * as ComputeGrpc from '../../../api-client/compute'
import * as ResourceUtils from '../../utilities.ts'

import * as DiskSchema from './disk.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusDisk = Alchemy.Resource<'Nebius.compute.v1.Disk', DiskSchema.DiskProps, DiskSchema.DiskAttributes>

export const NebiusDisk = Alchemy.Resource<NebiusDisk>('Nebius.compute.v1.Disk')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusDiskSchema.Disk} (metadata + spec + status)
 * into {@link DiskSchema.DiskAttributes}.
 */
const toFriendlyAttributes = (rawDisk: NebiusDiskSchema.Disk): DiskSchema.DiskAttributes =>
  ResourceUtils.toFriendlyAttributes<DiskSchema.DiskAttributes>({
    rawResource: rawDisk,
    resourceSchema: NebiusDiskSchema.Disk,
  })

// ----- PROVIDER

export const NebiusDiskProvider = AlchemyProvider.succeed(NebiusDisk, {
  // Observe → Ensure → Sync → Return
  reconcile: Effect.fn('Nebius.compute.v1.Disk.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}

    // Validate user input at runtime
    news = yield* DiskSchema.validateDiskProps(news)

    const computeGrpcService = yield* ComputeGrpc.ComputeGrpcService

    // 1. Observe — fetch live state if we have a cached physical ID
    let disk: NebiusDiskSchema.Disk | undefined
    if (output?.id) {
      disk = yield* computeGrpcService.disk
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    if (!disk) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.compute.v1.Disk (${name})`)
      disk = yield* computeGrpcService.disk.create({
        metadata: { parentId, name, labels },
        spec: NebiusDiskSchema.DiskSpec.fromJSON(news),
      })
    }

    // 3. Sync — update if spec drifted from desired
    const desired = NebiusDiskSchema.DiskSpec.fromJSON(news)
    if (
      disk.spec &&
      (!AlchemyDiff.deepEqual(disk.spec.sizeGibibytes, desired.sizeGibibytes) ||
        !AlchemyDiff.deepEqual(disk.spec.blockSizeBytes, desired.blockSizeBytes) ||
        disk.spec.type !== desired.type ||
        disk.spec.forbidDeletion !== desired.forbidDeletion)
    ) {
      yield* session.note(`Updating Nebius.compute.v1.Disk (${disk.metadata!.name})`)
      disk = yield* computeGrpcService.disk.update({
        metadata: {
          id: disk.metadata!.id,
          resourceVersion: disk.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    // 4. Return — fresh Attributes
    return toFriendlyAttributes(disk)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.compute.v1.Disk',
    resourceLabel: 'Disk',
    service: ComputeGrpc.ComputeGrpcService,
    deleteById: (svc, id) => svc.disk.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.compute.v1.Disk',
    service: ComputeGrpc.ComputeGrpcService,
    getById: (svc, id) => svc.disk.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.compute.v1.Disk',
    service: ComputeGrpc.ComputeGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.disk.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.compute.v1.Disk.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
