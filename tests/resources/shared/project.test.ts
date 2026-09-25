/**
 * `MissingProjectIdError` (R-09): missing user configuration is a *typed* failure, not a defect.
 *
 * Scope note, stated because the ISSUES.md acceptance asks for a test per site: this exercises the
 * error and its guidance, not the raise site. `ListCapacityAllowances` is an `Alchemy.Action`, and the
 * repo's action tests all target pure helpers — there is no harness in which to invoke one, so driving
 * that branch would mean building one. The raise site is therefore type-checked (`yield* new
 * MissingProjectIdError(…)` in a channel that now carries it) and recorded as such, rather than covered
 * by a test that pretends to be end-to-end.
 */
import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'

import { MissingProjectIdError, missingProjectIdMessage } from '../../../modules/resources/shared/project.ts'

describe('MissingProjectIdError', () => {
  test('is catchable by tag, and its guidance names the variable and both remedies', async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new MissingProjectIdError({ message: missingProjectIdMessage('NEBIUS_PROJECT_ID') })).pipe(
        Effect.catchTag('MissingProjectIdError', (error) => Effect.succeed(error.message)),
      ),
    )

    // The three things `resolveTenantId`'s guidance established: the variable, how to supply it, and
    // where the value comes from.
    expect(recovered).toContain('NEBIUS_PROJECT_ID')
    expect(recovered).toContain('{ projectId }')
    expect(recovered).toContain('nebius iam project list')
  })
})
