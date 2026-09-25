/**
 * The missing-project-ID failure, mirroring `shared/tenant.ts`'s `MissingTenantIdError`.
 *
 * **Tagged, not a defect.** Needing `NEBIUS_PROJECT_ID` is a *user configuration* condition: the
 * caller can catch it, print the guidance and exit non-zero, and nothing about the program is broken.
 * It used to be a `die`d `Error` at the one site that needs it
 * (`capacity/v1 actions.ListCapacityAllowances`), which no caller can `catchTag`, retry, or classify —
 * a defect reports as a crash, and the guidance it carried was only visible by reading it (R-09).
 */
import * as Schema from 'effect/Schema'

export class MissingProjectIdError extends Schema.TaggedError<MissingProjectIdError>()('MissingProjectIdError', {
  message: Schema.String,
}) {}

/**
 * The guidance text — the same shape as `resolveTenantId`'s: name the variable, say how to supply it,
 * say where to find the value. Kept beside the error so every raise site reads identically.
 */
export const missingProjectIdMessage = (envVar: string): string =>
  [
    `Nebius project ID is required for this operation but ${envVar} is not set.`,
    '',
    'How to supply it:',
    '  - pass `{ projectId }` to the operation, or',
    `  - export ${envVar}=<project-id>   (required for env/CI auth)`,
    '',
    'Where to find it: `nebius iam project list`.',
  ].join('\n')
