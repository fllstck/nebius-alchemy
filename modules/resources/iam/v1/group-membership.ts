import * as Effect from 'effect/Effect'
import * as Schedule from 'effect/Schedule'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusGroupMembershipSchema from '../../../../schemas/nebius/iam/v1/group_membership'
import * as IamGrpc from '../../../api-client/iam'
import * as ResourceUtils from '../../utilities.ts'

import * as GroupMembershipSchema from './group-membership.schema.ts'
import * as Factory from '../../factory.ts'
import { GrpcError } from '../../../api-client/grpc-utils.ts'

// ----- RESOURCE TYPES

export type NebiusGroupMembership = Alchemy.Resource<
  'Nebius.iam.v1.GroupMembership',
  GroupMembershipSchema.GroupMembershipProps,
  GroupMembershipSchema.GroupMembershipAttributes
>

export const NebiusGroupMembership =
  Alchemy.Resource<NebiusGroupMembership>('Nebius.iam.v1.GroupMembership')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusGroupMembershipSchema.GroupMembership,
): GroupMembershipSchema.GroupMembershipAttributes =>
  ResourceUtils.toFriendlyAttributes<GroupMembershipSchema.GroupMembershipAttributes>({
    rawResource: raw,
    resourceSchema: NebiusGroupMembershipSchema.GroupMembership,
  })

// ----- PROVIDER

export const NebiusGroupMembershipProvider = AlchemyProvider.succeed(NebiusGroupMembership, {
  reconcile: Effect.fn('Nebius.iam.v1.GroupMembership.reconcile')(function* ({ id, news, output, session }) {
    news = yield* GroupMembershipSchema.validateGroupMembershipProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    // Check if membership already exists by listing members and finding a match
    let membership: NebiusGroupMembershipSchema.GroupMembership | undefined
    if (output?.id) {
      membership = yield* iam.groupMembership
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!membership) {
      // Check for existing membership with same memberId in this group to avoid duplicates
      const existingMembers = yield* iam.groupMembership.listMembers(news.parentId).pipe(
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<NebiusGroupMembershipSchema.GroupMembership>)),
      )
      const existing = existingMembers.find(
        (m) => m.spec?.memberId === news.memberId,
      )
      if (existing) {
        return toFriendlyAttributes(existing)
      }

      const name = `gm-${id.replace(/_/g, '-').toLowerCase().slice(0, 55)}`
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.iam.v1.GroupMembership (${name})`)
      // NOTE: metadata.name must be omitted — the Nebius API rejects it for
      // group memberships (verified against the live API).
      membership = yield* iam.groupMembership
        .create({
          metadata: { parentId: news.parentId, labels },
          spec: NebiusGroupMembershipSchema.GroupMembershipSpec.fromPartial({
            memberId: news.memberId,
          }),
          ...(news.revokeAfterHours ? { revokeAfterHours: news.revokeAfterHours } : {}),
        })
        // The member/parent (typically just-created resources) may not be
        // resolvable by the membership backend yet — Nebius eventually-consistent
        // replication for direct-API-created IAM resources (observed 0s–5min+;
        // CLI/gosdk-created resources resolve instantly). Bounded NOT_FOUND
        // retry as a backstop for the common same-deploy identity flow.
        .pipe(
          Effect.retry({
            times: 6,
            schedule: Schedule.spaced('5 seconds'),
            while: (e) => e instanceof GrpcError && e.code === 5,
          }),
        )
    }

    return toFriendlyAttributes(membership)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.GroupMembership',
    resourceLabel: 'GroupMembership',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.groupMembership.delete(id),
  }),

  read: Effect.fn('Nebius.iam.v1.GroupMembership.read')(function* ({ id, output }) {
    if (!output?.id) return undefined
    const iam = yield* IamGrpc.IamGrpcService
    const membership = yield* iam.groupMembership
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    if (!membership) return undefined
    const attrs = toFriendlyAttributes(membership)
    if (yield* AlchemyTags.hasAlchemyTags(id, membership.metadata?.labels || {})) {
      return attrs
    }
    return Alchemy.AdoptPolicy.Unowned(attrs)
  }),

  // list is per-group (parentId from props), not project-scoped — return []
  list: Effect.fn('Nebius.iam.v1.GroupMembership.list')(() => Effect.succeed([])),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.GroupMembership.diff')(function* ({ news, olds }) {
    news = news || ({} as GroupMembershipSchema.GroupMembershipProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    // memberId is immutable
    if (news.memberId !== olds?.memberId) return { action: 'replace' }
    // parentId is immutable (membership can't move groups)
    if (news.parentId !== olds?.parentId) return { action: 'replace' }
    return undefined
  }),
})
