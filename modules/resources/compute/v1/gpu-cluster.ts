import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Schema from 'effect/Schema'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusGpuClusterSchema from '../../../../schemas/nebius/compute/v1/gpu_cluster.ts'
import * as ComputeGrpc from '../../../api-client/compute.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as GpuClusterSchema from './gpu-cluster.schema.ts'
import * as Factory from '../../factory.ts'
import * as IamGrpc from '../../../api-client/iam.ts'

// ----- ERRORS

/**
 * Raised instead of deleting a GpuCluster that still has instances attached.
 *
 * The framework already deletes in-stack dependents first (an Instance that
 * references `cluster.id` is deleted before its cluster — see AGENTS.md
 * §"Replace ordering"), so members found here are either out-of-band (created
 * outside this stack) or the old generation of a *replace* of this cluster with
 * a pinned `name`: a delete-first replace runs inside this resource's node,
 * before its dependents' own replacement.
 */
export class GpuClusterNotEmpty extends Schema.TaggedError<GpuClusterNotEmpty>()('GpuClusterNotEmpty', {
  gpuClusterId: Schema.String,
  gpuClusterName: Schema.String,
  instances: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

// ----- RESOURCE TYPES

export type NebiusGpuCluster = Alchemy.Resource<
  'Nebius.compute.v1.GpuCluster',
  GpuClusterSchema.GpuClusterProps,
  GpuClusterSchema.GpuClusterAttributes
>

export const NebiusGpuCluster = Alchemy.Resource<NebiusGpuCluster>('Nebius.compute.v1.GpuCluster')

// ----- HELPERS

const toFriendlyAttributes = (raw: NebiusGpuClusterSchema.GpuCluster): GpuClusterSchema.GpuClusterAttributes =>
  ResourceUtils.toFriendlyAttributes<GpuClusterSchema.GpuClusterAttributes>({
    rawResource: raw,
    resourceSchema: NebiusGpuClusterSchema.GpuCluster,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusGpuClusterProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusGpuCluster>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusGpuCluster>, never, any>)
  : AlchemyProvider.succeed(NebiusGpuCluster, {
      reconcile: Effect.fn('Nebius.compute.v1.GpuCluster.reconcile')(function* ({ id, news, output, session }) {
        news = yield* GpuClusterSchema.validateGpuClusterProps(news)

        const svc = yield* ComputeGrpc.ComputeGrpcService

        let cluster: NebiusGpuClusterSchema.GpuCluster | undefined
        if (output?.id) {
          cluster = yield* svc.gpuCluster
            .get(output.id)
            .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
        }

        if (!cluster) {
          const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
          const name =
            news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
          const internalLabels = yield* AlchemyTags.createInternalTags(id)
          const labels = { ...internalLabels, ...news.labels }

          yield* session.note(`Creating Nebius.compute.v1.GpuCluster (${name})`)
          cluster = yield* svc.gpuCluster.create({
            metadata: { parentId, name, labels },
            // No enum fields in `GpuClusterSpec` → `fromPartial` (see AGENTS.md).
            spec: NebiusGpuClusterSchema.GpuClusterSpec.fromPartial({ infinibandFabric: news.infinibandFabric }),
          })
        }

        // No update path: `GpuClusterSpec` is a single immutable field
        // (`infinibandFabric`), so a change is a `replace` (see `diff`) — the
        // API's Update RPC could only ever be sent the value it already has.
        return toFriendlyAttributes(cluster)
      }),

      delete: Effect.fn('Nebius.compute.v1.GpuCluster.delete')(function* ({ output, session }) {
        const svc = yield* ComputeGrpc.ComputeGrpcService

        // Pre-flight: the API refuses to delete a cluster that still has
        // members, and a raw rejection would not say which instances to look at.
        // A missing cluster means there is nothing to guard (idempotent delete).
        const current = yield* svc.gpuCluster
          .get(output.id)
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
        if (!current) return

        const members = current.status?.instances ?? []
        if (members.length > 0) {
          return yield* new GpuClusterNotEmpty({
            gpuClusterId: output.id,
            gpuClusterName: current.metadata?.name ?? output.id,
            instances: members,
            message: [
              `GpuCluster ${current.metadata?.name ?? output.id} still has ${members.length} instance(s) attached: ${members.join(', ')}.`,
              'A GPU cluster cannot be emptied in place (`Instance.gpuCluster` is create-only), so delete or replace those instances first.',
              'If this is a *replace* of the cluster itself, note that a pinned `name` forces delete-first ordering — let the name be auto-generated, or recreate the members first.',
            ].join(' '),
          })
        }

        yield* session.note(`Deleting Nebius.compute.v1.GpuCluster (${current.metadata?.name ?? output.id})`)
        yield* svc.gpuCluster.delete(output.id)
      }),

      read: Factory.makeCrudRead({
        resourceName: 'Nebius.compute.v1.GpuCluster',
        validate: GpuClusterSchema.validateGpuClusterProps,
        service: ComputeGrpc.ComputeGrpcService,
        getById: (svc, id) => svc.gpuCluster.get(id),
        toAttrs: (raw) => toFriendlyAttributes(raw),
      }),

      list: Factory.makeTenantScopedList({
        resourceName: 'Nebius.compute.v1.GpuCluster',
        service: ComputeGrpc.ComputeGrpcService,
        iamService: IamGrpc.IamGrpcService,
        projectList: (iam, tenantId) => iam.project.list(tenantId),
        projectId: (project) => project.metadata!.id,
        listByParent: (svc, parentId) => svc.gpuCluster.list(parentId),
        toAttrs: (raw) => toFriendlyAttributes(raw),
      }),

      // eslint-disable-next-line require-yield
      diff: Effect.fn('Nebius.compute.v1.GpuCluster.diff')(function* ({ news, olds }) {
        news = news || ({} as GpuClusterSchema.GpuClusterProps)
        if (!AlchemyDiff.isResolved(news)) return undefined

        // Plan-time props validation — fail `alchemy plan` fast, before any API call.
        yield* GpuClusterSchema.validateGpuClusterProps(news)

        // `infinibandFabric` names a physical fabric — immutable. The parent and
        // the physical name are unchanged, so the ordering depends on whether the
        // name was pinned (see Factory.replaceKeepingName).
        if (news.infinibandFabric !== olds?.infinibandFabric) return Factory.replaceKeepingName(news)

        // A name change is create-first: a different physical name.
        return Factory.nameChangeRequiresReplace(news, olds)
      }),
    })
