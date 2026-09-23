/**
 * Shared input types used by api-client services.
 *
 * Every Nebius CRUD resource accepts these identical shapes for create
 * and update calls. Defining them once avoids ~20 copies across service files.
 */

/** Standard input for `create` operations across all Nebius CRUD services. */
export interface CreateInput {
  readonly metadata: { parentId?: string; name?: string; labels?: Record<string, string> }
  readonly spec: {}
}

/**
 * Standard input for `update` operations across all Nebius CRUD services.
 *
 * `labels` is part of the update metadata on the wire — measured 2026-09-24
 * (`spikes/labels-convergence-probe.ts`, on a `vpc/v1 Network`): an update whose `metadata.labels` adds a
 * key stores it, one that drops a key deletes it in the cloud, and one that omits the key entirely leaves
 * the live map alone. The type omitted it until the fleet-wide `labels` convergence made updates send it
 * (AGENTS.md §Convergence), which is why every update site now merges
 * `Factory.mergedLabels(id, news.labels)` into the metadata it sends.
 */
export interface UpdateInput {
  readonly metadata: {
    id: string
    parentId?: string
    resourceVersion?: number | string
    labels?: Record<string, string>
  }
  readonly spec: {}
}
