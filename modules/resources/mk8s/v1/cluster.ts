import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import Long from 'long'

import * as NebiusClusterSchema from '../../../../schemas/nebius/mk8s/v1/cluster.ts'
import * as Mk8sGrpc from '../../../api-client/mk8s.ts'
import * as IamGrpc from '../../../api-client/iam.ts'

import * as ClusterSchema from './cluster.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusCluster = Alchemy.Resource<
  'Nebius.mk8s.v1.Cluster',
  ClusterSchema.ClusterProps,
  ClusterSchema.ClusterAttributes
>

export const NebiusCluster = Alchemy.Resource<NebiusCluster>('Nebius.mk8s.v1.Cluster')

// ----- HELPERS

const toFriendlyAttributes = (raw: NebiusClusterSchema.Cluster): ClusterSchema.ClusterAttributes =>
  ClusterSchema.toFriendlyAttributes(raw)

/**
 * Build the spec we want the API to hold, **omitting** what the props omit.
 *
 * The omissions are the point. There is no `FieldMask` anywhere in `mk8s/v1`
 * (measured 2026-09-23), so an absent field means "leave whatever is there" —
 * which is why an optional prop that the user *removes* must not be sent as a
 * zero value: `fromPartial` would default an unset `version` to `""`, the API
 * would ignore it, and reconcile would re-send it on every pass without ever
 * converging.
 */
const desiredSpec = (news: ClusterSchema.ClusterProps): NebiusClusterSchema.ClusterSpec =>
  NebiusClusterSchema.ClusterSpec.fromPartial({
    controlPlane: {
      ...(news.version !== undefined ? { version: news.version } : {}),
      subnetId: news.subnetId,
      ...(news.etcdClusterSize !== undefined
        ? { etcdClusterSize: Long.fromNumber(news.etcdClusterSize) }
        : {}),
      // Presence is the switch: the proto models the endpoint as an empty message.
      ...(news.publicEndpoint !== undefined
        ? {
            endpoints: {
              publicEndpoint: { allowedCidrs: [...(news.publicEndpoint.allowedCidrs ?? [])] },
            },
          }
        : {}),
      ...(news.auditLogs ? { auditLogs: {} } : {}),
      ...(news.karpenter ? { karpenter: {} } : {}),
    },
    ...(news.serviceCidrs !== undefined ? { kubeNetwork: { serviceCidrs: [...news.serviceCidrs] } } : {}),
  })

/**
 * The drift list: everything `reconcile` is expected to write back in place.
 *
 * Extracted and exported (as `instanceSpecDrifted` is) so the convergence
 * contract is unit-testable directly, without an engine or an API.
 *
 * ## Why every optional prop is guarded on the **news** side
 *
 * `news.<prop> !== undefined &&` is not defensive style — it is load-bearing.
 * There is no `FieldMask`, so "field absent" means *leave unchanged*, not
 * *clear*. If the user removes an optional prop, `desired` carries the field's
 * zero value (`""`, `Long.ZERO`, `[]`), the live spec still holds the old value,
 * and a comparison without the guard reports drift on **every** reconcile: the
 * update is accepted, nothing changes, and it never converges. AGENTS.md
 * §"Resource Lifecycle Details" records the four providers that shipped this bug.
 *
 * The guards matter even though this API does **not** materialize defaults into
 * `spec` (verified 2026-09-23), because the loop comes from the *removal* case,
 * not from a defaulted echo.
 *
 * The two **immutable** props — `subnetId` and `serviceCidrs` — are deliberately
 * absent: a change to either is planned as a `replace` by `diff`, so reconcile
 * can only ever receive them unchanged. Sending them is harmless (they are part
 * of `desired`), but comparing them would be dead code that looks live.
 */
export const clusterSpecDrifted = (
  live: NebiusClusterSchema.Cluster['spec'],
  desired: NebiusClusterSchema.ClusterSpec,
  news: ClusterSchema.ClusterProps,
): boolean => {
  if (!live) return false
  const liveCp = live.controlPlane
  const desiredCp = desired.controlPlane

  return (
    // Immutable-by-plan, so only the *unchanged* case can reach here.
    liveCp?.subnetId !== desiredCp?.subnetId ||
    (news.version !== undefined && liveCp?.version !== desiredCp?.version) ||
    (news.etcdClusterSize !== undefined &&
      !(liveCp?.etcdClusterSize ?? Long.ZERO).equals(desiredCp?.etcdClusterSize ?? Long.ZERO)) ||
    // `publicEndpoint` is a *presence* switch, so compare the switch itself and
    // then the allow-list. A present live endpoint with no CIDRs and a desired
    // `{}` are the same request ("create it, unrestricted").
    (news.publicEndpoint !== undefined &&
      (liveCp?.endpoints?.publicEndpoint === undefined ||
        !sameStringSet(
          liveCp.endpoints.publicEndpoint.allowedCidrs,
          desiredCp?.endpoints?.publicEndpoint?.allowedCidrs,
        ))) ||
    (news.auditLogs !== undefined && (liveCp?.auditLogs === undefined) !== (desiredCp?.auditLogs === undefined)) ||
    (news.karpenter !== undefined && (liveCp?.karpenter === undefined) !== (desiredCp?.karpenter === undefined))
  )
}

/** Order-insensitive comparison for a CIDR allow-list (the API treats it as a set). */
const sameStringSet = (live: ReadonlyArray<string> | undefined, desired: ReadonlyArray<string> | undefined) => {
  const a = [...(live ?? [])].toSorted()
  const b = [...(desired ?? [])].toSorted()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusClusterProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusCluster>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusCluster>, never, any>)
  : AlchemyProvider.succeed(NebiusCluster, {
      reconcile: Effect.fn('Nebius.mk8s.v1.Cluster.reconcile')(function* ({ id, news, output, session, olds }) {
        news = yield* ClusterSchema.validateClusterProps(news)

        const svc = yield* Mk8sGrpc.Mk8sGrpcService

        let cluster: NebiusClusterSchema.Cluster | undefined
        if (output?.id) {
          cluster = yield* svc.cluster
            .get(output.id)
            .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
        }

    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
        if (!cluster) {
          const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
          const name =
            news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
          yield* session.note(`Creating Nebius.mk8s.v1.Cluster (${name})`)
          cluster = yield* svc.cluster.create({
            metadata: { parentId, name, labels },
            spec: desiredSpec(news),
          })
        }

        const desired = desiredSpec(news)
        if (
      (
clusterSpecDrifted(cluster.spec, desired, news)
      ) ||
      // A labels-only change is not a spec drift, so it needs its own trigger — carrying the merged map
      // in `metadata.labels` converges only if this fires.
      Factory.labelsDrifted(cluster.metadata?.labels, news.labels, olds?.labels)
    ) {
          yield* session.note(`Updating Nebius.mk8s.v1.Cluster (${cluster.metadata!.name})`)
          // `resourceVersion` is the optimistic-concurrency token; `Get` exposes it
          // as a string, which is what `UpdateClusterRequest.metadata` wants back.
          cluster = yield* svc.cluster.update({
            metadata: {
              id: cluster.metadata!.id,
              resourceVersion: cluster.metadata!.resourceVersion.toString(),
              labels,
            },
            spec: desired,
          })
        }

        return toFriendlyAttributes(cluster)
      }),

      // No delete pre-check, and that is a measured decision: deleting a cluster
      // that still holds node groups **cascades** (2026-09-23) — the node group, the
      // node's compute instance and its boot disk all went away, and the call
      // answered `status: OK`. So there is no `…NotEmpty` guard to write, unlike
      // `compute/v1 GpuCluster`.
      //
      // `makeCrudDelete` is therefore the right shape: it is idempotent by
      // construction (NOT_FOUND → success), which matters *more* here than
      // elsewhere — a cluster delete removes its node groups, so a later
      // `NodeGroup.delete` will legitimately find nothing.
      delete: Factory.makeCrudDelete({
        resourceName: 'Nebius.mk8s.v1.Cluster',
        resourceLabel: 'Cluster',
        service: Mk8sGrpc.Mk8sGrpcService,
        deleteById: (svc, id) => svc.cluster.delete(id),
      }),

      read: Factory.makeCrudRead({
        resourceName: 'Nebius.mk8s.v1.Cluster',
        validate: ClusterSchema.validateClusterProps,
        service: Mk8sGrpc.Mk8sGrpcService,
        getById: (svc, id) => svc.cluster.get(id),
        toAttrs: (raw) => toFriendlyAttributes(raw),
      }),

      list: Factory.makeTenantScopedList({
        resourceName: 'Nebius.mk8s.v1.Cluster',
        service: Mk8sGrpc.Mk8sGrpcService,
        iamService: IamGrpc.IamGrpcService,
        projectList: (iam, tenantId) => iam.project.list(tenantId),
        projectId: (project) => project.metadata!.id,
        listByParent: (svc, parentId) => svc.cluster.list(parentId),
        toAttrs: (raw) => toFriendlyAttributes(raw),
      }),

      // eslint-disable-next-line require-yield
      diff: Effect.fn('Nebius.mk8s.v1.Cluster.diff')(function* ({ news, olds }) {
        news = news || ({} as ClusterSchema.ClusterProps)
        if (!AlchemyDiff.isResolved(news)) return undefined

        // Plan-time props validation — fail `alchemy plan` fast, before any API call.
        yield* ClusterSchema.validateClusterProps(news)

        // Two props are create-only (measured 2026-09-23):
        //   - `subnetId`: the API answers an opaque `13 INTERNAL` and changes
        //     nothing, so the replacement must be planned rather than attempted;
        //   - `serviceCidrs`: reserved inside the control-plane subnet at creation,
        //     and absent from `cluster update`.
        // Both are spec-only changes with the identity (parent, name) intact, which
        // is exactly what `replaceKeepingName` resolves.
        if (news.subnetId !== olds?.subnetId) return Factory.replaceKeepingName(news)
        if (!sameStringSet(news.serviceCidrs, olds?.serviceCidrs)) return Factory.replaceKeepingName(news)

        // A name (or parent) change is create-first: a different identity.
        return Factory.identityChangeRequiresReplace(news, olds)
      }),
    })
