import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusBucketSchema from '../../../../schemas/nebius/storage/v1/bucket.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as StorageGrpc from '../../../api-client/storage.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as BucketSchema from './bucket.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusBucket = Alchemy.Resource<
  'Nebius.storage.v1.Bucket',
  BucketSchema.BucketProps,
  BucketSchema.BucketAttributes
>

export const NebiusBucket = Alchemy.Resource<NebiusBucket>('Nebius.storage.v1.Bucket')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusBucketSchema.Bucket} (metadata + spec +
 * status) into {@link BucketSchema.BucketAttributes}.
 */
const toFriendlyAttributes = (rawBucket: NebiusBucketSchema.Bucket): BucketSchema.BucketAttributes =>
  ResourceUtils.toFriendlyAttributes<BucketSchema.BucketAttributes>({
    rawResource: rawBucket,
    resourceSchema: NebiusBucketSchema.Bucket,
    overrides: {
      maxSizeBytes: rawBucket.spec!.maxSizeBytes.toString(),
    },
  })

/** Compare spec fields between desired (fromJSON) and current (from API). */
const specDrifted = (current: NebiusBucketSchema.BucketSpec, desired: NebiusBucketSchema.BucketSpec): boolean =>
  current.versioningPolicy !== desired.versioningPolicy ||
  !current.maxSizeBytes.equals(desired.maxSizeBytes) ||
  current.defaultStorageClass !== desired.defaultStorageClass ||
  current.forceStorageClass !== desired.forceStorageClass ||
  current.objectAuditLogging !== desired.objectAuditLogging ||
  !AlchemyDiff.deepEqual(current.lifecycleConfiguration, desired.lifecycleConfiguration) ||
  !AlchemyDiff.deepEqual(current.cors, desired.cors) ||
  !AlchemyDiff.deepEqual(current.bucketPolicy, desired.bucketPolicy)

// ----- PROVIDER

/**
 * Guard so the bundler's `__ALCHEMY_RUNTIME__` fold DCEs the deploy-time
 * provider (gRPC clients, protobuf schemas, factory helpers) out of Worker
 * bundles. A Worker only imports the construct for registration — it never
 * invokes the provider — but the module-scope `AlchemyProvider.succeed(...)`
 * call kept the whole deploy graph alive. At deploy time the flag is
 * undefined and the real provider is registered; in a bundled Worker the
 * fold turns this into `undefined` and the branch (and every grpc/schema
 * import it references) is eliminated. Mirrors the D8 bundle-safety pattern
 * in `resources/storage/v1/bindings.ts`.
 */
export const NebiusBucketProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusBucket>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusBucket>, never, any>)
  : AlchemyProvider.succeed(NebiusBucket, {
  // Observe → Ensure → Sync → Return
  // (see https://v2.alchemy.run/infrastructure-as-code/custom-provider/#implement-reconcile)
  reconcile: Effect.fn('Nebius.storage.v1.Bucket.reconcile')(function* ({ id, news, output, session }) {
    // When props are fully optional and the user passes none, news is undefined.
    news = news || {}

    // Validate user input at runtime — catches what TypeScript can't
    news = yield* BucketSchema.validateBucketProps(news)

    const storageGrpcService = yield* StorageGrpc.StorageGrpcService

    // 1. Observe — fetch live state if we have a cached physical ID
    let bucket: NebiusBucketSchema.Bucket | undefined
    if (output?.id) {
      bucket = yield* storageGrpcService.bucket
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    if (!bucket) {
      const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.storage.v1.Bucket (${name})`)
      bucket = yield* storageGrpcService.bucket.create({
        metadata: { parentId, name, labels },
        spec: NebiusBucketSchema.BucketSpec.fromJSON(news),
      })
    }

    // 3. Sync — update if spec drifted from desired
    const desired = NebiusBucketSchema.BucketSpec.fromJSON(news)
    if (bucket.spec && specDrifted(bucket.spec, desired)) {
      yield* session.note(`Updating Nebius.storage.v1.Bucket (${bucket.metadata!.name})`)
      bucket = yield* storageGrpcService.bucket.update({
        metadata: {
          id: bucket.metadata!.id,
          resourceVersion: bucket.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    // 4. Return — fresh Attributes
    return toFriendlyAttributes(bucket)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.storage.v1.Bucket',
    resourceLabel: 'Bucket',
    service: StorageGrpc.StorageGrpcService,
    deleteById: (svc, id) => svc.bucket.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.storage.v1.Bucket',
    service: StorageGrpc.StorageGrpcService,
    getById: (svc, id) => svc.bucket.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.storage.v1.Bucket',
    service: StorageGrpc.StorageGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.bucket.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.storage.v1.Bucket.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
