import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as Ids from '../../../../modules/resources/iam/v1/ids.ts'

/**
 * Live `AccessPermit` lifecycle — the spec-only **replace** introduced by N2.
 *
 * The service has no Update RPC, so a `role` change can only land by replacing
 * the permit. This is the case that pins the **delete-first** ordering: a permit
 * sends no `metadata.name` (the API rejects it — verified live), so the grant's
 * identity is server-side `(group, resource)` and a create-first replacement
 * would ask for a grant the old permit still holds. Reconcile's `(resourceId,
 * role)` dedup makes it worse rather than better: running after the delete it
 * finds nothing and creates, whereas running before it would adopt the stale
 * permit it was racing with.
 *
 * The group is created in-stack and re-declared in the second `stack.deploy` —
 * each deploy states the full desired set, so omitting it would plan the
 * group's deletion (same staged pattern as `secret-version.integration.test.ts`).
 */
integrationTest(test.provider, 'Nebius.iam.v1.AccessPermit lifecycle', (stack) =>
  Effect.gen(function* () {
    const projectId = yield* Config.String('NEBIUS_PROJECT_ID')

    const declare = (role: string) =>
      Effect.gen(function* () {
        const group = yield* Nebius.iam.Group('PermitTestGroup', {})
        const permit = yield* Nebius.iam.AccessPermit('PermitTest', {
          parentId: group.id,
          // The permit targets the project itself: a throwaway group holding
          // `viewer`/`editor` on the project is the cheapest real grant.
          resourceId: Ids.AccessPermitResourceId.make(projectId),
          role,
        })
        return { group, permit }
      })

    const first = yield* stack.deploy(declare('viewer'))
    expect(first.permit.id).toBeDefined()
    expect(first.permit.role).toBe('viewer')
    console.log(`PROBE AccessPermit created: id=${first.permit.id} role=${first.permit.role}`)

    const second = yield* stack.deploy(declare('editor'))

    // A new id proves the plan was a replace, not the `update` that wrote
    // nothing — the bug N2 fixed. Delete-first is what let the create succeed:
    // the old permit (same group, same resource) was gone by then.
    expect(second.permit.id).not.toBe(first.permit.id)
    expect(second.permit.role).toBe('editor')
  }).pipe(safeDestroy(stack)),
  { timeout: 300_000 },
)
