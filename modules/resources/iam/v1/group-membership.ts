import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusGroupMembershipSchema from '../../../../schemas/nebius/iam/v1/group_membership.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as GroupMembershipSchema from './group-membership.schema.ts'
import * as Factory from '../../factory.ts'
import { GrpcError } from '../../../api-client/grpc-utils.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

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

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusGroupMembershipProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusGroupMembership>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusGroupMembership>, never, any>)
  : AlchemyProvider.succeed(NebiusGroupMembership, {
  // GroupMembership is a sub-resource of a Group — nuke deletes memberships
  // before their group (Nebius does not cascade-delete associated resources).
  nuke: { dependsOn: ['Nebius.iam.v1.Group'] },

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

  read: Effect.fn('Nebius.iam.v1.GroupMembership.read')(function* ({ id, olds: props, output }) {
    if (!output?.id) {
      // Plan-time props validation for greenfield — `read` is the only provider
      // hook alchemy calls when there is no persisted state (see makeCrudRead).
      if (props != null) yield* GroupMembershipSchema.validateGroupMembershipProps(props)
      return undefined
    }
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

  // GroupMembership is a sub-resource of a Group — enumerate every project
  // group and list its members. Without this, nuke can't delete memberships
  // before their group, so group deletes would fail or leak memberships.
  list: Effect.fn('Nebius.iam.v1.GroupMembership.list')(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    const projects = yield* iam.project.list(tenantId)
    const rows = yield* Effect.forEach(projects, (project) =>
      iam.group.list(project.metadata!.id).pipe(
        Effect.flatMap((groups) =>
          Effect.forEach(groups, (group) =>
            iam.groupMembership.listMembers(group.metadata!.id).pipe(
              Effect.map((members) => members.map((m) => toFriendlyAttributes(m))),
              Effect.catch(() => Effect.succeed([] as GroupMembershipSchema.GroupMembershipAttributes[])),
            ),
          ),
        ),
        Effect.map((nested) => nested.flat()),
        Effect.catch(() => Effect.succeed([] as GroupMembershipSchema.GroupMembershipAttributes[])),
      ),
    )
    return rows.flat()
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.GroupMembership.diff')(function* ({ news, olds }) {
    news = news || ({} as GroupMembershipSchema.GroupMembershipProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* GroupMembershipSchema.validateGroupMembershipProps(news)
    // memberId is immutable
    if (news.memberId !== olds?.memberId) return { action: 'replace' }
    // parentId is immutable (membership can't move groups)
    if (news.parentId !== olds?.parentId) return { action: 'replace' }
    return undefined
  }),
})
