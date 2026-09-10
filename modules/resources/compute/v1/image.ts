import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusImageSchema from '../../../../schemas/nebius/compute/v1/image.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ComputeGrpc from '../../../api-client/compute.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as ImageSchema from './image.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusImage = Alchemy.Resource<'Nebius.compute.v1.Image', ImageSchema.ImageProps, ImageSchema.ImageAttributes>

export const NebiusImage = Alchemy.Resource<NebiusImage>('Nebius.compute.v1.Image')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusImageSchema.Image} (metadata + spec + status)
 * into {@link ImageSchema.ImageAttributes}.
 */
const toFriendlyAttributes = (rawImage: NebiusImageSchema.Image): ImageSchema.ImageAttributes =>
  ResourceUtils.toFriendlyAttributes<ImageSchema.ImageAttributes>({
    rawResource: rawImage,
    resourceSchema: NebiusImageSchema.Image,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusImageProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusImage>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusImage>, never, any>)
  : AlchemyProvider.succeed(NebiusImage, {
  // Observe → Ensure → Sync → Return
  reconcile: Effect.fn('Nebius.compute.v1.Image.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}

    // Validate user input at runtime
    news = yield* ImageSchema.validateImageProps(news)

    const computeGrpcService = yield* ComputeGrpc.ComputeGrpcService

    // 1. Observe — fetch live state if we have a cached physical ID
    let image: NebiusImageSchema.Image | undefined
    if (output?.id) {
      image = yield* computeGrpcService.image
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
    if (!image) {
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.compute.v1.Image (${name})`)
      image = yield* computeGrpcService.image.create({
        metadata: { parentId, name, labels },
        spec: NebiusImageSchema.ImageSpec.fromJSON(news),
      })
    }

    // 3. Sync — update if spec drifted from desired
    const desired = NebiusImageSchema.ImageSpec.fromJSON(news)
    if (
      image.spec &&
      (!AlchemyDiff.deepEqual(image.spec.description, desired.description) ||
        image.spec.imageFamily !== desired.imageFamily ||
        image.spec.version !== desired.version ||
        image.spec.imageFamilyHumanReadable !== desired.imageFamilyHumanReadable)
    ) {
      yield* session.note(`Updating Nebius.compute.v1.Image (${image.metadata!.name})`)
      image = yield* computeGrpcService.image.update({
        metadata: {
          id: image.metadata!.id,
          parentId,
          resourceVersion: image.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    // 4. Return — fresh Attributes
    return toFriendlyAttributes(image)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.compute.v1.Image',
    resourceLabel: 'Image',
    service: ComputeGrpc.ComputeGrpcService,
    deleteById: (svc, id) => svc.image.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.compute.v1.Image',
    validate: ImageSchema.validateImageProps,
    service: ComputeGrpc.ComputeGrpcService,
    getById: (svc, id) => svc.image.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.compute.v1.Image',
    service: ComputeGrpc.ComputeGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.image.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.compute.v1.Image.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* ImageSchema.validateImageProps(news)

    // The proto marks every `oneof source` arm IMMUTABLE, so a different source
    // cannot be applied by an update — plan a replace instead of letting the
    // update call fail on the API.
    if (
      news.sourceDiskId !== olds?.sourceDiskId ||
      news.sourceDiskSnapshotId !== olds?.sourceDiskSnapshotId ||
      !AlchemyDiff.deepEqual(news.sourceStorage, olds?.sourceStorage)
    ) {
      return { action: 'replace' }
    }

    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
