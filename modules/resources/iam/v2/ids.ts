import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'

// Canonical branded-ID home for `nebius.iam.v2`. See `../v1/ids.ts` for the
// naming rules (AGENTS.md §"Branded IDs — everywhere").

/** Branded ID for Project resources. */
export const ProjectId = Schema.String.check(
  Validation.isResourceId('project-', 'Project'),
).pipe(Schema.brand('ProjectId'))
export type ProjectId = typeof ProjectId.Type

/** Branded ID for Tenant resources (the parent of a Project). */
export const TenantId = Schema.String.pipe(Schema.brand('TenantId'))
export type TenantId = typeof TenantId.Type

/** Branded ID for AccessKey resources. */
export const AccessKeyId = Schema.String.pipe(Schema.brand('AccessKeyId'))
export type AccessKeyId = typeof AccessKeyId.Type
