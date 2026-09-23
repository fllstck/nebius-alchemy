import * as Schema from 'effect/Schema'

// ---------------------------------------------------------------------------
// Branded IDs — mk8s/v1
// ---------------------------------------------------------------------------
//
// One `ids.ts` per service version (AGENTS.md §"Branded IDs — everywhere").
//
// Measured live 2026-09-23: both types are `mk8s<type>-<base32>`-shaped
// (`mk8scluster-e00mn89kpc6f8bgd01`, `mk8snodegroup-e00qz5ptbkeqppax21`) and both
// answer `resourceVersion: 1` right after creation.
//
// Neither carries a prefix refinement, matching `GpuClusterId`/`DiskId`: the
// service is the authority on shape, and a `mk8s…-` check on a *brand* would
// reject ids produced by any future service rename for no added safety.

/** Branded ID for an mk8s Cluster. */
export const ClusterId = Schema.String.pipe(Schema.brand('ClusterId'))
export type ClusterId = typeof ClusterId.Type

/**
 * Branded ID for an mk8s NodeGroup.
 *
 * Its parent is a **Cluster**, not the project — the same shape as
 * `SubnetId` being parented by a network — so a node group id is meaningful
 * only together with its cluster.
 */
export const NodeGroupId = Schema.String.pipe(Schema.brand('NodeGroupId'))
export type NodeGroupId = typeof NodeGroupId.Type
