import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Schema from 'effect/Schema'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusNVLInstanceGroupSchema from '../../../../schemas/nebius/compute/v1/nvlinstancegroup.ts'
import * as ComputeGrpc from '../../../api-client/compute.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as NVLInstanceGroupSchema from './nvl-instance-group.schema.ts'
import * as Factory from '../../factory.ts'
import * as IamGrpc from '../../../api-client/iam.ts'

// ----- ERRORS

/**
 * Raised instead of deleting an NVLInstanceGroup that still has instances.
 *
 * Same reasoning as `GpuClusterNotEmpty`: the framework deletes in-stack
 * dependents first, so members here are out-of-band or the old generation of a
 * delete-first replacement of this group (pinned `name`).
 */
export class NVLInstanceGroupNotEmpty extends Schema.TaggedError<NVLInstanceGroupNotEmpty>()(
  'NVLInstanceGroupNotEmpty',
  {
    nvlInstanceGroupId: Schema.String,
    nvlInstanceGroupName: Schema.String,
    instances: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

// ----- RESOURCE TYPES

export type NebiusNVLInstanceGroup = Alchemy.Resource<
  'Nebius.compute.v1.NVLInstanceGroup',
  NVLInstanceGroupSchema.NVLInstanceGroupProps,
  NVLInstanceGroupSchema.NVLInstanceGroupAttributes
>

export const NebiusNVLInstanceGroup = Alchemy.Resource<NebiusNVLInstanceGroup>('Nebius.compute.v1.NVLInstanceGroup')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusNVLInstanceGroupSchema.NVLInstanceGroup,
): NVLInstanceGroupSchema.NVLInstanceGroupAttributes =>
  ResourceUtils.toFriendlyAttributes<NVLInstanceGroupSchema.NVLInstanceGroupAttributes>({
    rawResource: raw,
    resourceSchema: NebiusNVLInstanceGroupSchema.NVLInstanceGroup,
  })

/** The desired wire spec — `size` is an int64, so it goes over as its decimal string. */
const desiredSpec = (news: NVLInstanceGroupSchema.NVLInstanceGroupProps) =>
  NebiusNVLInstanceGroupSchema.NVLInstanceGroupSpec.fromJSON({
    type: news.type,
    size: String(news.size),
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusNVLInstanceGroupProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusNVLInstanceGroup>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusNVLInstanceGroup>, never, any>)
  : AlchemyProvider.succeed(NebiusNVLInstanceGroup, {
      reconcile: Effect.fn('Nebius.compute.v1.NVLInstanceGroup.reconcile')(function* ({ id, news, output, session }) {
        news = yield* NVLInstanceGroupSchema.validateNVLInstanceGroupProps(news)

        const svc = yield* ComputeGrpc.ComputeGrpcService

        let group: NebiusNVLInstanceGroupSchema.NVLInstanceGroup | undefined
        if (output?.id) {
          group = yield* svc.nvlInstanceGroup
            .get(output.id)
            .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
        }

        const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))

        if (!group) {
          const name =
            news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
          const internalLabels = yield* AlchemyTags.createInternalTags(id)
          const labels = { ...internalLabels, ...news.labels }

          yield* session.note(`Creating Nebius.compute.v1.NVLInstanceGroup (${name})`)
          group = yield* svc.nvlInstanceGroup.create({
            metadata: { parentId, name, labels },
            // Enum-bearing spec (`type`) → `fromJSON` (see AGENTS.md).
            spec: desiredSpec(news),
          })
        }

        // `size` is adjustable in place (unlike `type`, which replaces — see
        // `diff`). Shrinking below the current member count is left to the API:
        // it owns the rule, and a local guard could block a legal resize.
        const desired = desiredSpec(news)
        if (group.spec && !ResourceUtils.specDeepEqual(group.spec, desired)) {
          yield* session.note(`Updating Nebius.compute.v1.NVLInstanceGroup (${group.metadata!.name})`)
          group = yield* svc.nvlInstanceGroup.update({
            metadata: {
              id: group.metadata!.id,
              parentId,
              resourceVersion: group.metadata!.resourceVersion.toString(),
            },
            spec: desired,
          })
        }

        return toFriendlyAttributes(group)
      }),

      delete: Effect.fn('Nebius.compute.v1.NVLInstanceGroup.delete')(function* ({ output, session }) {
        const svc = yield* ComputeGrpc.ComputeGrpcService

        const current = yield* svc.nvlInstanceGroup
          .get(output.id)
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
        if (!current) return

        const members = Object.keys(current.status?.instances ?? {})
        if (members.length > 0) {
          return yield* new NVLInstanceGroupNotEmpty({
            nvlInstanceGroupId: output.id,
            nvlInstanceGroupName: current.metadata?.name ?? output.id,
            instances: members,
            message: [
              `NVLInstanceGroup ${current.metadata?.name ?? output.id} still has ${members.length} instance(s): ${members.join(', ')}.`,
              'Delete or replace those instances first (`Instance.nvlInstanceGroupId` can also be changed in place to move an instance out of the group).',
              'If this is a *replace* of the group itself, note that a pinned `name` forces delete-first ordering — let the name be auto-generated, or drain the members first.',
            ].join(' '),
          })
        }

        yield* session.note(`Deleting Nebius.compute.v1.NVLInstanceGroup (${current.metadata?.name ?? output.id})`)
        yield* svc.nvlInstanceGroup.delete(output.id)
      }),

      read: Factory.makeCrudRead({
        resourceName: 'Nebius.compute.v1.NVLInstanceGroup',
        validate: NVLInstanceGroupSchema.validateNVLInstanceGroupProps,
        service: ComputeGrpc.ComputeGrpcService,
        getById: (svc, id) => svc.nvlInstanceGroup.get(id),
        toAttrs: (raw) => toFriendlyAttributes(raw),
      }),

      list: Factory.makeTenantScopedList({
        resourceName: 'Nebius.compute.v1.NVLInstanceGroup',
        service: ComputeGrpc.ComputeGrpcService,
        iamService: IamGrpc.IamGrpcService,
        projectList: (iam, tenantId) => iam.project.list(tenantId),
        projectId: (project) => project.metadata!.id,
        listByParent: (svc, parentId) => svc.nvlInstanceGroup.list(parentId),
        toAttrs: (raw) => toFriendlyAttributes(raw),
      }),

      // eslint-disable-next-line require-yield
      diff: Effect.fn('Nebius.compute.v1.NVLInstanceGroup.diff')(function* ({ news, olds }) {
        news = news || ({} as NVLInstanceGroupSchema.NVLInstanceGroupProps)
        if (!AlchemyDiff.isResolved(news)) return undefined

        // Plan-time props validation — fail `alchemy plan` fast, before any API call.
        yield* NVLInstanceGroupSchema.validateNVLInstanceGroupProps(news)

        // `type` corresponds to the Compute platform — immutable, and the parent
        // and physical name are unchanged, so the ordering depends on whether the
        // name was pinned (see Factory.replaceKeepingName).
        if (news.type !== olds?.type) return Factory.replaceKeepingName(news)

        // `size` is an in-place update (reconcile sends it) — nothing to plan.
        // A name change is create-first: a different physical name.
        return Factory.identityChangeRequiresReplace(news, olds)
      }),
    })
