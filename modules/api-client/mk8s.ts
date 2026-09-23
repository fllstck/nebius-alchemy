import * as Effect from 'effect'

import type { Cluster } from '../../schemas/nebius/mk8s/v1/cluster.ts'
import {
  CreateClusterRequest,
  GetClusterRequest,
  ListClustersRequest,
  UpdateClusterRequest,
  DeleteClusterRequest,
  ListClusterControlPlaneVersionsRequest,
} from '../../schemas/nebius/mk8s/v1/cluster_service.ts'
import type { ClusterControlPlaneVersion } from '../../schemas/nebius/mk8s/v1/cluster_service.ts'
import type { NodeGroup } from '../../schemas/nebius/mk8s/v1/node_group.ts'
import {
  CreateNodeGroupRequest,
  GetNodeGroupRequest,
  ListNodeGroupsRequest,
  UpdateNodeGroupRequest,
  DeleteNodeGroupRequest,
  PreflightCheckNodeGroupRequest,
  GetNodeGroupCompatibilityMatrixRequest,
} from '../../schemas/nebius/mk8s/v1/node_group_service.ts'
import type {
  PreflightCheckNodeGroupResponse,
  NodeGroupCompatibilityMatrix,
  DeepPartial,
} from '../../schemas/nebius/mk8s/v1/node_group_service.ts'
import { GetByNameRequest } from '../../schemas/nebius/common/v1/metadata.ts'
import * as NebiusClusterServiceSchema from '../../schemas/nebius/mk8s/v1/cluster_service.ts'
import * as NebiusNodeGroupServiceSchema from '../../schemas/nebius/mk8s/v1/node_group_service.ts'
import * as GrpcUtils from './grpc-utils.ts'
import type { CreateInput, UpdateInput } from './types.ts'
import { NebiusGrpcTransport } from './GrpcTransport.ts'

// ---------------------------------------------------------------------------
// Managed Kubernetes (mk8s) — Cluster + NodeGroup
// ---------------------------------------------------------------------------
//
// Both services live on `mk8s.api.nebius.cloud:443` (already in
// `modules/endpoints.ts`), and both are ordinary CRUD services whose
// create/update/delete return `Operation` — so `wrapWithOperationPolling`
// applies unchanged. What differs from the compute/VPC services is documented
// per member below; the short version:
//
// 1. **`Get*Request` carries `resourceVersion` in addition to `id`**, so the
//    polling wrapper's `getRequest` must build it with `fromPartial({ id })` —
//    the case AGENTS.md §"Protobuf Serialization" calls out ("if they have
//    fields beyond `id`, provide a custom `getRequest`").
// 2. **Both services have `getByName`**, so `mapInput` maps it as
//    `quota-allowance` does.
// 3. **Provisioning is slow.** A 1-etcd cluster reached `RUNNING` in ~3 min
//    (2026-09-23) and a node group provisions real compute instances on top of
//    that; an HA control plane and GPU nodes take longer still. The polling
//    deadline is therefore raised to the same 20 min the AI services use, not
//    the 5 min default.
// 4. **No `FieldMask` anywhere** — updates send `{ metadata, spec }` and an
//    absent field means "leave unchanged" (measured 2026-09-23: nothing the
//    caller omitted is materialized into `spec`). See TASKS.md §NEXT UP for the
//    full probe record.
//
// `NodeGroupService/Upgrade` is deliberately **not** wrapped: it mutates
// (bumps the infra patch version of every node group member) and has no
// reference implementation in the ecosystem — the Nebius solutions library
// never calls it, relying on a `version` change instead. Adding it later is an
// imperative action (like IAM's `Issue`), not a provider prop; leaving it out is
// a decision, not an omission.

// ---------------------------------------------------------------------------
// Cluster service — operation-aware interface
// ---------------------------------------------------------------------------

export type CreateClusterInput = CreateInput

export type UpdateClusterInput = UpdateInput

/**
 * Preflight inputs accept a **partial** request.
 *
 * `PreflightCheckNodeGroupRequest`'s nested messages (`PreflightCheckContext`,
 * `ResourceMetadata`) are non-optional in the generated interface, so a caller
 * handing us a plain object would have to spell out every field. The generated
 * `DeepPartial` (what `fromPartial` is parameterised by) is the honest input type:
 * it is what the request builder actually accepts.
 */
export type PreflightCheckNodeGroupInput = DeepPartial<PreflightCheckNodeGroupRequest>

/** Same partial-input treatment for the compatibility matrix request. */
export type NodeGroupCompatibilityMatrixInput = DeepPartial<GetNodeGroupCompatibilityMatrixRequest>

export interface ClusterService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<Cluster, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /**
   * Read a cluster by name within its IAM container. The managed-Kubernetes
   * equivalent of `getByName` on the other CRUD services — useful for adoption,
   * since a cluster is expensive to recreate.
   */
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Cluster, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List every cluster in an IAM container (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Cluster>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateClusterInput,
  ) => Effect.Effect.Effect<
    Cluster,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateClusterInput,
  ) => Effect.Effect.Effect<
    Cluster,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  /**
   * Delete a cluster. **This cascades**: measured 2026-09-23, deleting a cluster
   * that still had a node group with a running node succeeded (`status: OK`) and
   * removed the node group, that node's compute instance *and* its boot disk.
   * There is no `…NotEmpty` precondition (contrast `compute/v1 GpuCluster`).
   */
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >

  // --- Read-only extras ---

  /**
   * Every Kubernetes release the API offers, with `deprecated`/`restricted`/
   * `endOfLife` flags. Takes **no parent** — the list is global. This is the
   * only safe way to choose a `version`: measured 2026-09-23 the API offered
   * 1.30–1.36 with **1.31 already `deprecated` (end of life 2026-09-01)** and 1.30
   * before it, so a hard-coded default goes stale silently — and the flags make
   * that checkable at plan time instead of guessable.
   *
   * An `Effect` **property**, not a `() => Effect` method: an Effect is already a
   * lazy description, so a zero-argument wrapper adds indirection for nothing
   * (`effect-tsgo` flags it as `lazyEffect`, as it does `Provider.ts`'s
   * `providers()`). Read it with `yield* mk8s.cluster.listControlPlaneVersions`.
   *
   * Returns the **unwrapped array**, not the RPC's response envelope. The
   * endpoint has no paging fields at all, so it is not paginated — and because it
   * is a plain passthrough it would otherwise hand back the whole response
   * message. {@link clusterControlPlaneVersions} is exported so that unwrapping is
   * unit-testable: on 2026-09-23 the first version of this member declared an
   * array while returning `{ items }`, and the `as unknown as` cast hid it until a
   * live call failed with `versions.map is not a function`.
   */
  readonly listControlPlaneVersions: Effect.Effect.Effect<
    ReadonlyArray<ClusterControlPlaneVersion>,
    GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// NodeGroup service — operation-aware interface
// ---------------------------------------------------------------------------

export type CreateNodeGroupInput = CreateInput

export type UpdateNodeGroupInput = UpdateInput

export interface NodeGroupService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<NodeGroup, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** Read a node group by name within its **parent cluster**. */
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<NodeGroup, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /**
   * List every node group of one **cluster** (paginates automatically). The
   * parent is the cluster, not the project — and against a cluster that no
   * longer exists the API answers `NotFound: resource "mk8scluster-…" not found`,
   * naming the *cluster* rather than the node group (measured 2026-09-23).
   */
  readonly list: (
    clusterId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<NodeGroup>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateNodeGroupInput,
  ) => Effect.Effect.Effect<
    NodeGroup,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateNodeGroupInput,
  ) => Effect.Effect.Effect<
    NodeGroup,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >

  // --- Read-only, but load-bearing ---

  /**
   * Server-side preflight check of a proposed node-group create/update.
   *
   * This is the API's own answer to "which changes force a recreate?", and it is
   * a **generic Nebius facility** (`nebius.common.v1`), not mk8s-specific: the
   * request context takes `action` (`CREATE`/`UPDATE`/`RECREATE`/`DELETE`),
   * `tool` (documented examples: `"terraform"`, `"cli"`, `"console"`),
   * `unknownPaths` (values the caller cannot know yet — e.g. an unresolved
   * `Output`) and `pathsRequireRecreate`; the response returns `diagnostics`,
   * `pathsRequireRecreate` and `requiresUserApproval`.
   *
   * Read-only: it evaluates and returns, creating nothing. Wrapped here as a
   * passthrough so the provider can consult it instead of hard-coding an
   * immutability table — but its exact response semantics are **not yet
   * verified against the live API**, so treat it as a validated request shape
   * rather than a trusted oracle until a probe confirms what the returned
   * paths mean. See TASKS.md §NEXT UP.
   */
  readonly preflightCheck: (
    req: PreflightCheckNodeGroupInput,
  ) => Effect.Effect.Effect<
    PreflightCheckNodeGroupResponse,
    GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError
  >
  /**
   * Which `os` / `drivers_preset` combinations a `(kubernetesVersion, platform)`
   * pair supports. This is what makes `template.os` and
   * `gpuSettings.driversPreset` authorable instead of guessable: measured
   * 2026-09-23, `1.31` + `gpu-h200-sxm` → `ubuntu24.04`, and a second entry
   * adding `drivers_preset: cuda12.8`.
   */
  readonly getCompatibilityMatrix: (
    req: NodeGroupCompatibilityMatrixInput,
  ) => Effect.Effect.Effect<
    NodeGroupCompatibilityMatrix,
    GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface Mk8sGrpcServiceShape {
  readonly cluster: ClusterService
  readonly nodeGroup: NodeGroupService
}

export class Mk8sGrpcService extends Effect.Context.Service<Mk8sGrpcService, Mk8sGrpcServiceShape>()(
  'Mk8sGrpcService',
) {}

// ---------------------------------------------------------------------------
// Pagination request builders
// ---------------------------------------------------------------------------
//
// Exported like `nvlInstanceGroupListRequest` so the request shape — in
// particular `pageSize: 100`, which some list endpoints reject — is
// unit-testable and probe-able without an engine.

/** Build a `ListClusters` request page (parent = IAM container, usually a project). */
export const clusterListRequest = (parentId: string, pageToken: string) =>
  ListClustersRequest.fromPartial({ parentId, pageSize: 100, pageToken })

/** Build a `ListNodeGroups` request page (parent = **cluster**, not project). */
export const nodeGroupListRequest = (clusterId: string, pageToken: string) =>
  ListNodeGroupsRequest.fromPartial({ parentId: clusterId, pageSize: 100, pageToken })

/**
 * Unwrap the control-plane version catalogue from its response envelope.
 *
 * Exported (and used by the client) so the `items` unwrapping is covered by a
 * unit test rather than only by a live call — the RPC returns
 * `ListClusterControlPlaneVersionsResponse`, which is *not* an array.
 */
export const clusterControlPlaneVersions = (response: {
  items: ReadonlyArray<ClusterControlPlaneVersion>
}): ReadonlyArray<ClusterControlPlaneVersion> => response.items

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

/**
 * Provisioning and roll-out are both slow (a node group creates real compute
 * instances and waits for them to join). Matches the 20 min the AI services use
 * rather than the 5 min default — the polling deadline is a *diagnostic*
 * ("stuck, not slow"), so a too-tight value turns a healthy GPU roll-out into a
 * false failure.
 */
const POLL_DEADLINE_MS = 20 * 60 * 1000

const makeClusterService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusClusterServiceSchema.ClusterServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.mk8s.v1.ClusterService',
    polling: ['create', 'update'],
    forget: ['delete'],
    pollDeadlineMs: POLL_DEADLINE_MS,
    transport,
    // `GetClusterRequest` has `{ id, resourceVersion }`, so it cannot be built by
    // spreading the id — see AGENTS.md §"Protobuf Serialization".
    getRequest: (id) => GetClusterRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => GetClusterRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateClusterInput) => CreateClusterRequest.fromPartial(req),
      update: (req: UpdateClusterInput) => UpdateClusterRequest.fromPartial(req),
      delete: (id: string) => DeleteClusterRequest.fromPartial({ id }),
    },
  }) as unknown as ClusterService

  const list = (parentId: string) =>
    GrpcUtils.paginateAll((req) => raw.list(req), clusterListRequest, parentId)

  // The version catalogue is a passthrough (no paging fields at all), so the wrapper
  // would hand back the response *message*; unwrap it here to match the interface. It
  // goes through `raw` rather than the wrapper: `mapInput` shapes requests only, and
  // the wrapper's member is typed with the *unwrapped* return type, so building the
  // empty request at the call site keeps both honest.
  const listControlPlaneVersions = raw
    .listControlPlaneVersions(ListClusterControlPlaneVersionsRequest.fromPartial({}))
    .pipe(Effect.Effect.map(clusterControlPlaneVersions))

  return { ...polled, list, listControlPlaneVersions }
})

const makeNodeGroupService = Effect.Effect.gen(function* () {
  const raw = yield* GrpcUtils.makeGrpcService(NebiusNodeGroupServiceSchema.NodeGroupServiceClient)
  const transport = yield* NebiusGrpcTransport

  const polled = GrpcUtils.wrapWithOperationPolling(raw, {
    serviceName: 'nebius.mk8s.v1.NodeGroupService',
    polling: ['create', 'update'],
    forget: ['delete'],
    pollDeadlineMs: POLL_DEADLINE_MS,
    transport,
    // `GetNodeGroupRequest` also carries `resourceVersion` beyond `id`.
    getRequest: (id) => GetNodeGroupRequest.fromPartial({ id }),
    mapInput: {
      get: (id: string) => GetNodeGroupRequest.fromPartial({ id }),
      getByName: (req: { parentId: string; name: string }) => GetByNameRequest.fromPartial(req),
      create: (req: CreateNodeGroupInput) => CreateNodeGroupRequest.fromPartial(req),
      update: (req: UpdateNodeGroupInput) => UpdateNodeGroupRequest.fromPartial(req),
      delete: (id: string) => DeleteNodeGroupRequest.fromPartial({ id }),
      preflightCheck: (req: PreflightCheckNodeGroupInput) => PreflightCheckNodeGroupRequest.fromPartial(req),
      getCompatibilityMatrix: (req: NodeGroupCompatibilityMatrixInput) =>
        GetNodeGroupCompatibilityMatrixRequest.fromPartial(req),
    },
  }) as unknown as NodeGroupService

  const list = (clusterId: string) =>
    GrpcUtils.paginateAll((req) => raw.list(req), nodeGroupListRequest, clusterId)

  return { ...polled, list }
})

export const Mk8sGrpcServiceLive = Effect.Layer.effect(
  Mk8sGrpcService,
  Effect.Effect.gen(function* () {
    const cluster = yield* makeClusterService
    const nodeGroup = yield* makeNodeGroupService
    return { cluster, nodeGroup }
  }),
)
