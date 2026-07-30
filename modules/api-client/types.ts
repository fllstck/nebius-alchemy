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

/** Standard input for `update` operations across all Nebius CRUD services. */
export interface UpdateInput {
  readonly metadata: { id: string; resourceVersion?: number | string }
  readonly spec: {}
}
