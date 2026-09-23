import * as Alchemy from 'alchemy'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Mk8sGrpc from '../../../api-client/mk8s.ts'
import type { ClusterControlPlaneVersion } from '../../../../schemas/nebius/mk8s/v1/cluster_service.ts'
import type { NodeGroupCompatibilityMatrix } from '../../../../schemas/nebius/mk8s/v1/node_group_service.ts'

// ── mk8s discovery (read-only) ─────────────────────────────────────────────
//
// `NodeGroup.template.os` and `template.gpuSettings.driversPreset` are **not**
// constants that can be validated locally: which images a node group may use
// depends on the cluster's Kubernetes version *and* the hardware platform, and the
// cluster's own version catalogue moves (measured 2026-09-23: 1.30–1.36, with 1.31
// already `deprecated` and past its end of life). So the props only check shape,
// and these two actions are what make the values authorable instead of guessable:
//
//   mk8s cluster list-control-plane-versions   → which `<major>.<minor>` to ask for
//   mk8s node-group get-compatibility-matrix   → which `os`/`driversPreset` pair that
//                                                version + platform supports
//
// Both are read-only (no create/update/delete anywhere in this file), and neither
// is consulted from a provider's `diff`: `diff` is pure for every Nebius resource
// (AGENTS.md), so a live RPC there is out of the question — that is what the
// `Nebius.mk8s.action.*` namespace is for.

/**
 * One entry of the cluster control-plane version catalogue, in the JSON rendering's
 * terms: `endOfLife` is an RFC 3339 string (the api-client decodes a `Date`, so the
 * conversion happens here rather than leaking a `Date` into an action's output).
 */
export interface ClusterControlPlaneVersionRow {
  /** `<major>.<minor>` — the exact form the Cluster's `version` takes. */
  version: string
  /** Available to internal Nebius use only until the feature flag is enabled for you. */
  restricted: boolean
  /** Creation of clusters with this version is forbidden — it is on its way out. */
  deprecated: boolean
  /**
   * RFC 3339 timestamp after which the platform forces the version out of use, or
   * `undefined` when it did not report one.
   */
  endOfLife: string | undefined
}

/**
 * Map the control-plane version catalogue to plain rows.
 *
 * Exported for the same reason `filterResourceAdvice` is: an `Alchemy.Action` resolves through
 * the stack and cannot be called standalone, so the *shaping* is what a unit test can reach —
 * and it is where the two easy mistakes live (leaking a `Date` out of the action, and
 * forgetting that `endOfLife` is absent for most versions).
 */
export const toControlPlaneVersionRows = (
  rows: ReadonlyArray<ClusterControlPlaneVersion>,
): ReadonlyArray<ClusterControlPlaneVersionRow> =>
  rows.map((row) => ({
    version: row.version,
    restricted: row.restricted,
    deprecated: row.deprecated,
    // The api-client decodes the timestamp to a JS `Date` (decoded protobuf, not the JSON
    // rendering), so convert it here — `DateTime` rather than `toISOString()`, per
    // AGENTS.md §Tips, and never leak a `Date` out of an action.
    endOfLife:
      row.endOfLife === undefined ? undefined : DateTime.formatIso(DateTime.fromDateUnsafe(row.endOfLife)),
  }))

/**
 * List the Kubernetes control-plane versions a cluster may be created with.
 *
 * Unfiltered and unpaginated (the RPC has no paging fields at all — that is why
 * `listControlPlaneVersions` in the api-client unwraps its response envelope).
 *
 * Use it before pinning `Cluster.version` or `NodeGroup.version`: pinning a version
 * that later goes deprecated is the failure mode both props invite, which is why
 * both are optional and default to the platform's own choice.
 */
export const ListClusterControlPlaneVersions = Alchemy.Action(
  'Nebius.mk8s.actions.ListClusterControlPlaneVersions',
  Effect.gen(function* () {
    const mk8s = yield* Mk8sGrpc.Mk8sGrpcService
    return () => Effect.map(mk8s.cluster.listControlPlaneVersions, toControlPlaneVersionRows)
  }),
)

/** One `(os, driversPreset)` pair a `(kubernetesVersion, platform)` pair supports. */
export interface NodeGroupImageRow {
  /**
   * OS image version — the value `template.os` takes (e.g. `ubuntu24.04`).
   * A CPU node group in the measured shape (2026-09-23, `1.31` + `gpu-h200-sxm`)
   * received one row with an empty `driversPreset`; a GPU row carried `cuda12.8`.
   */
  os: string
  /**
   * Driver preset — the value `template.gpuSettings.driversPreset` takes (e.g.
   * `cuda12.8`). Empty for CPU images (and for DRA-enabled GPU groups), which is the
   * form the proto documents for "no preinstalled drivers".
   */
  driversPreset: string
  /** Platforms this image is compatible with. */
  compatiblePlatforms: ReadonlyArray<string>
}

export interface NodeGroupCompatibilityRow {
  /** Kubernetes version this row describes (echoes the requested one). */
  kubernetesVersion: string
  items: ReadonlyArray<NodeGroupImageRow>
}

/**
 * Map the compatibility matrix to plain rows.
 *
 * Exported for the same reason as {@link toControlPlaneVersionRows}: the action cannot be
 * called standalone, so the shaping is what a test can pin — including the one shape that
 * matters for authoring (`driversPreset` is **empty** for CPU images, and empty is a real
 * answer here, not a missing one).
 */
export const toCompatibilityRows = (
  matrix: NodeGroupCompatibilityMatrix,
): ReadonlyArray<NodeGroupCompatibilityRow> =>
  matrix.versions.map((version) => ({
    kubernetesVersion: version.kubernetesVersion,
    items: version.items.map((item) => ({
      os: item.os,
      driversPreset: item.driversPreset,
      compatiblePlatforms: [...item.compatiblePlatforms],
    })),
  }))

/**
 * Which OS images and driver presets a Kubernetes version + platform supports.
 *
 * This is the authority behind `NodeGroup.template.os`; the action is deliberately
 * *not* wired into the provider (a plan must not make API calls), so the props
 * cannot reject a valid-but-unlisted image and cannot accept an invalid one either —
 * the API is the gate, and this is how a caller finds the right value first.
 */
export const GetNodeGroupCompatibilityMatrix = Alchemy.Action(
  'Nebius.mk8s.actions.GetNodeGroupCompatibilityMatrix',
  Effect.gen(function* () {
    const mk8s = yield* Mk8sGrpc.Mk8sGrpcService
    return (input: { clusterKubernetesVersion: string; platform: string }) =>
      Effect.map(
        mk8s.nodeGroup.getCompatibilityMatrix({
          clusterKubernetesVersion: input.clusterKubernetesVersion,
          platform: input.platform,
        }),
        toCompatibilityRows,
      )
  }),
)
