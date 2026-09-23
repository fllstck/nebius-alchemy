import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusNodeGroupSchema from '../../../../schemas/nebius/mk8s/v1/node_group.ts'
import * as Mk8sGrpc from '../../../api-client/mk8s.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

import * as NodeGroupSchema from './node-group.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusNodeGroup = Alchemy.Resource<
  'Nebius.mk8s.v1.NodeGroup',
  NodeGroupSchema.NodeGroupProps,
  NodeGroupSchema.NodeGroupAttributes
>

export const NebiusNodeGroup = Alchemy.Resource<NebiusNodeGroup>('Nebius.mk8s.v1.NodeGroup')

// ----- HELPERS

const toFriendlyAttributes = (raw: NebiusNodeGroupSchema.NodeGroup): NodeGroupSchema.NodeGroupAttributes =>
  NodeGroupSchema.toFriendlyAttributes(raw)

/**
 * `PercentOrCount` → its wire shape (plain objects; `NodeGroupSpec.fromJSON` converts the
 * numbers to `Long`s): `{count}` when a count was given, `{percent}` when a percent was.
 *
 * The props' filter guarantees exactly one of the two is set, so this never has to choose.
 */
const percentOrCountWire = (value: { count?: number; percent?: number }) =>
  value.count !== undefined ? { count: value.count } : { percent: value.percent }

/**
 * Build the spec we want the API to hold, from exactly what the props carry.
 *
 * `fromJSON` (not `fromPartial`) because `bootDisk.type` is an **enum**: the props spell it
 * as `'NETWORK_SSD'`, and `fromPartial` would pass that string straight through to the
 * int32 field, serializing as `NaN` (AGENTS.md §"Protobuf Serialization").
 *
 * The omissions are the point, but note that they are *not* what makes the drift check
 * safe — a ts-proto message value-exists for every scalar either way. The drift check
 * strips the unpinned defaults itself ({@link nodeGroupSpecDrifted}).
 */
export const desiredSpec = (news: NodeGroupSchema.NodeGroupProps): NebiusNodeGroupSchema.NodeGroupSpec =>
  NebiusNodeGroupSchema.NodeGroupSpec.fromJSON({
    ...(news.version !== undefined ? { version: news.version } : {}),
    ...(news.fixedNodeCount !== undefined ? { fixedNodeCount: news.fixedNodeCount } : {}),
    ...(news.autoscaling !== undefined
      ? {
          autoscaling: {
            minNodeCount: news.autoscaling.minNodeCount,
            maxNodeCount: news.autoscaling.maxNodeCount,
          },
        }
      : {}),
    ...(news.strategy !== undefined
      ? {
          strategy: {
            ...(news.strategy.maxUnavailable !== undefined
              ? { maxUnavailable: percentOrCountWire(news.strategy.maxUnavailable) }
              : {}),
            ...(news.strategy.maxSurge !== undefined
              ? { maxSurge: percentOrCountWire(news.strategy.maxSurge) }
              : {}),
            // `Duration.fromJSON` accepts **only** the `{seconds, nanos}` message form — the
            // canonical JSON string `"600s"` is silently dropped — so the seconds prop is mapped
            // here rather than passed through (AGENTS.md §Tips `Duration.Input`).
            ...(news.strategy.drainTimeoutSeconds !== undefined
              ? { drainTimeout: { seconds: news.strategy.drainTimeoutSeconds, nanos: 0 } }
              : {}),
          },
        }
      : {}),
    ...(news.autoRepair !== undefined
      ? {
          autoRepair: {
            conditions: news.autoRepair.conditions.map((condition) => ({
              type: condition.type,
              // A string enum: `fromJSON` converts it to the int32 the wire wants, which
              // `fromPartial` would have passed through as `NaN`.
              status: condition.status,
              ...(condition.timeoutSeconds !== undefined
                ? { timeout: { seconds: condition.timeoutSeconds, nanos: 0 } }
                : {}),
            })),
          },
        }
      : {}),
    template: {
      os: news.template.os,
      resources: {
        platform: news.template.resources.platform,
        ...(news.template.resources.preset !== undefined ? { preset: news.template.resources.preset } : {}),
      },
      bootDisk: {
        sizeGibibytes: news.template.bootDisk.sizeGibibytes,
        type: news.template.bootDisk.type,
        ...(news.template.bootDisk.blockSizeBytes !== undefined
          ? { blockSizeBytes: news.template.bootDisk.blockSizeBytes }
          : {}),
      },
      ...(news.template.networkInterfaces !== undefined
        ? {
            networkInterfaces: news.template.networkInterfaces.map((iface) => ({
              ...(iface.subnetId !== undefined ? { subnetId: iface.subnetId } : {}),
              // Presence is the switch: the proto models the address as an empty message
              // ("Set to empty value, to enable it").
              ...(iface.publicIpAddress ? { publicIpAddress: {} } : {}),
            })),
          }
        : {}),
      serviceAccountId: news.template.serviceAccountId,
      cloudInitUserData: news.template.cloudInitUserData,
      // Kubernetes node labels and the compute instance's own metadata labels — two distinct maps.
      ...(news.template.metadata !== undefined ? { metadata: { labels: { ...news.template.metadata.labels } } } : {}),
      ...(news.template.instanceMetadata !== undefined
        ? { instanceMetadata: { labels: { ...news.template.instanceMetadata.labels } } }
        : {}),
      ...(news.template.taints !== undefined
        ? {
            taints: news.template.taints.map((taint) => ({
              key: taint.key,
              value: taint.value,
              // String enum → int32 (`fromJSON`, not `fromPartial`).
              effect: taint.effect,
            })),
          }
        : {}),
      ...(news.template.filesystems !== undefined
        ? {
            filesystems: news.template.filesystems.map((filesystem) => ({
              attachMode: filesystem.attachMode,
              mountTag: filesystem.mountTag,
              existingFilesystem: { id: filesystem.existingFilesystem.id },
            })),
          }
        : {}),
      // Presence is the switch: the proto models preemptible nodes as an empty message.
      ...(news.template.preemptible ? { preemptible: {} } : {}),
      // The pricing oneof is **flat** on `NodeTemplate` — three sibling fields, and ts-proto emits no
      // `oneof` accessor — so the prop's arms spread straight onto them. An omitted prop sends nothing
      // (the platform's default), which is what makes the `omits` row in the convergence table hold.
      ...ResourceUtils.pricingModelFields(news.template.pricing),
      ...(news.template.localDisks !== undefined
        ? {
            localDisks: {
              ...(news.template.localDisks.passthroughGroup !== undefined
                ? { passthroughGroup: { requested: true } }
                : {}),
              ...(news.template.localDisks.config !== undefined
                ? {
                    config: {
                      ...(news.template.localDisks.config.none ? { none: true } : {}),
                      ...(news.template.localDisks.config.kubeletEphemeral ? { kubeletEphemeral: true } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(news.template.maxPods !== undefined ? { maxPods: news.template.maxPods } : {}),
      ...(news.template.gpuSettings !== undefined
        ? {
            gpuSettings: {
              ...(news.template.gpuSettings.driversPreset !== undefined
                ? { driversPreset: news.template.gpuSettings.driversPreset }
                : {}),
              // A presence switch in the proto's terms: enabling DRA is the only thing `true` can mean.
              ...(news.template.gpuSettings.dra ? { dra: true } : {}),
            },
          }
        : {}),
      ...(news.template.gpuCluster !== undefined ? { gpuCluster: { id: news.template.gpuCluster.id } } : {}),
      ...(news.template.nvlink !== undefined
        ? { nvlink: { nvlInstanceGroupId: news.template.nvlink.nvlInstanceGroupId } }
        : {}),
      ...(news.template.reservationPolicy !== undefined
        ? {
            reservationPolicy: {
              ...(news.template.reservationPolicy.policy !== undefined
                ? { policy: news.template.reservationPolicy.policy }
                : {}),
              ...(news.template.reservationPolicy.reservationIds !== undefined
                ? { reservationIds: [...news.template.reservationPolicy.reservationIds] }
                : {}),
            },
          }
        : {}),
    },
  })

/**
 * The drift list: everything `reconcile` writes back in place.
 *
 * ## One mechanism, not a hand-written guard per prop
 *
 * mk8s has **no `FieldMask`** (measured 2026-09-23), so an absent field means "leave
 * unchanged" and comparing an omitted prop against the API's echo is drift on every
 * reconcile, forever. Every other provider here expresses that with a hand-written
 * `news.<prop> !== undefined &&` guard, which is correct but has to be repeated for
 * every optional prop — and a prop someone forgets is a *silent* no-op (the class
 * `tests/convergence.test.ts` exists to catch).
 *
 * `NodeTemplate` is 17 fields with 12 nested messages, so this resource uses the
 * mechanical form of the same rule instead:
 *
 *   - {@link ResourceUtils.protoPinnedFields} drops every field the caller never set —
 *     the proto3 defaults (`""`, `0`, `Long.ZERO`, `[]`) that `fromJSON` fills in — while
 *     keeping an empty *object*, which is how a presence-only switch
 *     (`networkInterfaces[].publicIpAddress: {}`) is expressed;
 *   - {@link ResourceUtils.pinnedSpecDeepEqual} then compares **only** the surviving
 *     fields, with `specDeepEqual` at the leaves so int64s (`fixedNodeCount`, the boot
 *     disk size) stay visible instead of comparing equal to everything.
 *
 * Two consequences worth stating plainly, because both are properties a hand-written
 * guard list cannot offer:
 *
 *   1. **A prop cannot be forgotten here.** Adding a field to {@link desiredSpec} adds it
 *      to the comparison automatically; the convergence table's completeness check is what
 *      keeps `desiredSpec` and the props schema in step.
 *   2. **A platform-materialized default cannot loop.** Anything the API fills in and
 *      echoes back — the proto documents `maxPods` defaulting to `110`, and the same class
 *      bit `vpc/v1 Network`'s pools and `transfer.limiters` — is a field the caller did not
 *      pin, so it is never compared. (This is the hazard the whole-template
 *      `specDeepEqual` comparison planned in TASKS.md §N5 would have hit on the first
 *      live reconcile; the plan's "compare `template` as a whole" is superseded here.)
 *
 * `nvlink` is deliberately absent: it is create-only by plan (see `diff`), so reconcile
 * can only ever receive it unchanged. The same is true of `parentId`/`name`, which are
 * the identity.
 */
export const nodeGroupSpecDrifted = (
  live: NebiusNodeGroupSchema.NodeGroup['spec'],
  desired: NebiusNodeGroupSchema.NodeGroupSpec,
): boolean => {
  if (!live) return false
  return !ResourceUtils.pinnedSpecDeepEqual(live, ResourceUtils.protoPinnedFields(desired))
}

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusNodeGroupProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusNodeGroup>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusNodeGroup>, never, any>)
  : AlchemyProvider.succeed(NebiusNodeGroup, {
      reconcile: Effect.fn('Nebius.mk8s.v1.NodeGroup.reconcile')(function* ({ id, news, output, session }) {
        news = yield* NodeGroupSchema.validateNodeGroupProps(news)

        const svc = yield* Mk8sGrpc.Mk8sGrpcService

        let nodeGroup: NebiusNodeGroupSchema.NodeGroup | undefined
        if (output?.id) {
          nodeGroup = yield* svc.nodeGroup
            .get(output.id)
            .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
        }

        if (!nodeGroup) {
          // The parent is the **cluster** (not the project), so there is no `NEBIUS_PROJECT_ID`
          // fallback here: `parentId` is required in the props for exactly that reason.
          const name =
            news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
          const internalLabels = yield* AlchemyTags.createInternalTags(id)
          const labels = { ...internalLabels, ...news.labels }

          yield* session.note(`Creating Nebius.mk8s.v1.NodeGroup (${name})`)
          nodeGroup = yield* svc.nodeGroup.create({
            metadata: { parentId: news.parentId, name, labels },
            spec: desiredSpec(news),
          })
        }

        const desired = desiredSpec(news)
        if (nodeGroupSpecDrifted(nodeGroup.spec, desired)) {
          yield* session.note(`Updating Nebius.mk8s.v1.NodeGroup (${nodeGroup.metadata!.name})`)
          // `resourceVersion` is the optimistic-concurrency token; `Get` renders it as a
          // string, which is what `UpdateNodeGroupRequest.metadata` wants back.
          nodeGroup = yield* svc.nodeGroup.update({
            metadata: {
              id: nodeGroup.metadata!.id,
              resourceVersion: nodeGroup.metadata!.resourceVersion.toString(),
            },
            spec: desired,
          })
        }

        return toFriendlyAttributes(nodeGroup)
      }),

      // `NOT_FOUND` → success, and here that is a *reachable* path rather than hygiene: a
      // Cluster delete **cascades** to its node groups (measured 2026-09-23), so a node
      // group's delete legitimately finds nothing once its cluster is gone. `makeCrudDelete`
      // is idempotent by construction, which is why it is the right shape (AGENTS.md
      // §Convergence: a hand-written delete that throws on NOT_FOUND leaks parents).
      delete: Factory.makeCrudDelete({
        resourceName: 'Nebius.mk8s.v1.NodeGroup',
        resourceLabel: 'NodeGroup',
        service: Mk8sGrpc.Mk8sGrpcService,
        deleteById: (svc, id) => svc.nodeGroup.delete(id),
      }),

      read: Factory.makeCrudRead({
        resourceName: 'Nebius.mk8s.v1.NodeGroup',
        validate: NodeGroupSchema.validateNodeGroupProps,
        service: Mk8sGrpc.Mk8sGrpcService,
        getById: (svc, id) => svc.nodeGroup.get(id),
        toAttrs: (raw) => toFriendlyAttributes(raw),
      }),

      // Bespoke, not `makeTenantScopedList`: that helper fans out over **projects**, and
      // `ListNodeGroups`'s parent is a *cluster*, so asking it per project answers
      // `NotFound: resource "mk8scluster-<projectId>" not found` for every row — swallowed
      // as a best-effort `[]`, which would leave `alchemy unsafe nuke` blind to every node
      // group. The two-level fan-out is the same shape `dns/v1 Record` uses (projects →
      // zones → records).
      list: Effect.fn('Nebius.mk8s.v1.NodeGroup.list')(function* () {
        const svc = yield* Mk8sGrpc.Mk8sGrpcService
        const iam = yield* IamGrpc.IamGrpcService
        const tenantId = yield* resolveTenantId()

        const projects = yield* iam.project.list(tenantId)
        const rows = yield* Effect.forEach(projects, (project) =>
          svc.cluster
            .list(project.metadata!.id)
            .pipe(
              Effect.flatMap((clusters) =>
                Effect.forEach(clusters, (cluster) =>
                  svc.nodeGroup
                    .list(cluster.metadata!.id)
                    .pipe(
                      Effect.map((groups) => groups.map((raw) => toFriendlyAttributes(raw))),
                      Effect.catch(() => Effect.succeed([] as NodeGroupSchema.NodeGroupAttributes[])),
                    ),
                ),
              ),
              // One level per project, so the outer `flat()` lands on a flat list — the
              // two-level fan-out has to be flattened twice (the same shape `dns/v1 Record`
              // uses for projects → zones → records).
              Effect.map((nested) => nested.flat()),
              Effect.catch(() => Effect.succeed([] as NodeGroupSchema.NodeGroupAttributes[])),
            ),
        )

        return rows.flat()
      }),

      // eslint-disable-next-line require-yield
      diff: Effect.fn('Nebius.mk8s.v1.NodeGroup.diff')(function* ({ news, olds }) {
        news = news || ({} as NodeGroupSchema.NodeGroupProps)
        if (!AlchemyDiff.isResolved(news)) return undefined

        // Plan-time props validation — fail `alchemy plan` fast, before any API call.
        yield* NodeGroupSchema.validateNodeGroupProps(news)

        // Every arm's spec field is updatable in place: the API applies template changes as a roll-out
        // per the deployment strategy, and the sizing swap is **measured** to be in-place too
        // (2026-09-23: sending one side clears the other, the id is kept and `resourceVersion` moves by
        // one — see AGENTS.md §"Non-standard APIs" and the live test).
        //
        // `template.nvlink` is in the same class, which was **not** obvious and is why a replace branch
        // used to live here: the generated CLI omits `--template-nvlink-nvl-instance-group-id` from
        // `node-group update` (the usual create-only tell). Two probes settled it the other way —
        // `spikes/mk8s-nvlink-probe.ts` sent an update adding `nvlink` with a well-formed, non-existent
        // id and the API answered `NotFound: nvl instance group not found by id
        // "computenvlinstancegroup-…"`, i.e. it took the field and asked the compute service to resolve
        // the reference; and the earlier `PreflightCheck` run answered `requiresUserApproval: true` with
        // a roll-out warning rather than an immutability refusal. A change is therefore a roll-out, and
        // the pinned comparison converges it in place.
        //
        // Residual uncertainty, stated rather than hidden: a *successful* nvlink change could not be
        // exercised here (this tenant has no `GB200`/`GB300` entitlement and so no real
        // `NVLInstanceGroup` to point at). What is measured is that the field is not refused.
        //
        // So the only replace is a changed identity — parent cluster or physical name — which is
        // create-first because a different identity is a different resource.
        return Factory.identityChangeRequiresReplace(news, olds)
      }),
    })
