import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as IamGrpc from '../../../../modules/api-client/iam.ts'

/**
 * Live `GroupMembership` lifecycle — the spec-only **replace** introduced by N1b.
 *
 * `revokeAfterHours` was sent at create and compared nowhere, so changing it was
 * silently lost (the service has no Update RPC — its `Update` is an
 * `unimplemented` stub in the Terraform provider's own generated code). It is now
 * planned as a delete-first replace: the same `(parentId, memberId)` pair cannot
 * exist twice, and memberships send no `metadata.name` (the API rejects it), so
 * nothing else distinguishes the two generations.
 *
 * The member is a service account created in the same deploy — the provider's
 * bounded NOT_FOUND retry covers the documented replication delay for
 * direct-API-created IAM resources.
 */
integrationTest(test.provider, 'Nebius.iam.v1.GroupMembership lifecycle', (stack) =>
  Effect.gen(function* () {
    const declare = (revokeAfterHours: number) =>
      Effect.gen(function* () {
        const group = yield* Nebius.iam.Group('MembershipTestGroup', {})
        const serviceAccount = yield* Nebius.iam.ServiceAccount('MembershipTestSA', {
          description: 'group-membership integration test service account',
        })
        const membership = yield* Nebius.iam.GroupMembership('MembershipTest', {
          parentId: group.id,
          memberId: serviceAccount.id,
          revokeAfterHours,
        })
        return { group, serviceAccount, membership }
      })

    const first = yield* stack.deploy(declare(24))
    expect(first.membership.id).toMatch(/^groupmembership-/)

    // `revokeAt` is a TOP-LEVEL field the shared attribute mapper does not spread
    // (`GroupMembershipStatus` has no revoke field), so it needed an explicit
    // override — but the CREATE response does not carry it either. Probe a fresh
    // GET to record whether the API exposes the revocation time at all; the
    // replace below is what this test is actually for.
    const iam = yield* IamGrpc.IamGrpcService
    const fetched = yield* iam.groupMembership.get(first.membership.id)
    console.log(
      `PROBE GroupMembership created: id=${first.membership.id} revokeAfterHours=24 ` +
        `createResponse.revokeAt=${String(first.membership.revokeAt)} getResponse.revokeAt=${String(fetched.revokeAt)}`,
    )

    const second = yield* stack.deploy(declare(48))

    // A new id proves the change was planned as a replace, not the `update` that
    // wrote nothing (the N1b bug), and that the delete-first swap was accepted
    // for an already-existing (group, member) pair.
    expect(second.membership.id).not.toBe(first.membership.id)
  }).pipe(safeDestroy(stack)),
  { timeout: 300_000 },
)
