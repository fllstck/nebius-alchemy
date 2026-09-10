import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusInvitationSchema from '../../../../schemas/nebius/iam/v1/invitation.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as InvitationSchema from './invitation.schema.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

// ----- RESOURCE TYPES

export type NebiusInvitation = Alchemy.Resource<
  'Nebius.iam.v1.Invitation',
  InvitationSchema.InvitationProps,
  InvitationSchema.InvitationAttributes
>

export const NebiusInvitation = Alchemy.Resource<NebiusInvitation>('Nebius.iam.v1.Invitation')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusInvitationSchema.Invitation,
): InvitationSchema.InvitationAttributes =>
  ResourceUtils.toFriendlyAttributes<InvitationSchema.InvitationAttributes>({
    rawResource: raw,
    resourceSchema: NebiusInvitationSchema.Invitation,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusInvitationProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusInvitation>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusInvitation>, never, any>)
  : AlchemyProvider.succeed(NebiusInvitation, {
  reconcile: Effect.fn('Nebius.iam.v1.Invitation.reconcile')(function* ({ id, news, output, session }) {
    news = yield* InvitationSchema.validateInvitationProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    let invitation: NebiusInvitationSchema.Invitation | undefined
    if (output?.id) {
      invitation = yield* iam.invitation
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
      if (!invitation) {
        return yield* Effect.die(
          `Nebius.iam.v1.Invitation.reconcile: invitation ${output.id} disappeared. ` +
            `Invitations cannot be re-created with the same ID.`,
        )
      }

      // Handle resend if the user wants to re-send a pending invitation
      if (news.noSend === false && invitation.status?.state === 5 /* CREATED */) {
        yield* iam.invitation.resend(output.id)
        invitation = yield* iam.invitation.get(output.id)
      }

      // Update description if changed
      const desired = NebiusInvitationSchema.InvitationSpec.fromJSON({
        description: news.description || '',
        email: news.email,
      })
      if (invitation.spec && !AlchemyDiff.deepEqual(invitation.spec, desired)) {
        yield* session.note(`Updating Nebius.iam.v1.Invitation (${invitation.metadata!.name})`)
      invitation = yield* iam.invitation.update({
          metadata: {
            id: invitation.metadata!.id,
            resourceVersion: invitation.metadata!.resourceVersion.toString(),
          },
          spec: desired,
        })
      }

      return toFriendlyAttributes(invitation)
    }

    // Create new invitation — API rejects metadata.name
    const parentId = news.parentId || (yield* resolveTenantId())
    const internalLabels = yield* AlchemyTags.createInternalTags(id)
    const labels = { ...internalLabels, ...news.labels }

    yield* session.note(`Creating Nebius.iam.v1.Invitation (${news.email})`)
    invitation = yield* iam.invitation.create({
      metadata: { parentId, labels },
      spec: NebiusInvitationSchema.InvitationSpec.fromJSON({
        description: news.description || '',
        email: news.email,
      }),
      ...(news.noSend !== undefined ? { noSend: news.noSend } : {}),
      ...(news.expiresInSeconds ? { expiresIn: { seconds: String(news.expiresInSeconds) } } : {}),
    })

    return toFriendlyAttributes(invitation)
  }),

  delete: Effect.fn('Nebius.iam.v1.Invitation.delete')(function* ({ output, session }) {
    const iam = yield* IamGrpc.IamGrpcService
    yield* session.note(`Deleting Invitation (${output.id})`)
    yield* iam.invitation.delete(output.id)
  }),

  read: Effect.fn('Nebius.iam.v1.Invitation.read')(function* ({ id, output }) {
    if (!output?.id) return undefined
    const iam = yield* IamGrpc.IamGrpcService
    const invitation = yield* iam.invitation
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    if (!invitation) return undefined
    const attrs = toFriendlyAttributes(invitation)
    if (yield* AlchemyTags.hasAlchemyTags(id, invitation.metadata?.labels || {})) {
      return attrs
    }
    return Alchemy.AdoptPolicy.Unowned(attrs)
  }),

  list: Effect.fn('Nebius.iam.v1.Invitation.list')(function* () {
    const svc = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    const items = yield* svc.invitation.list(tenantId)
    return items.map(toFriendlyAttributes)
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.Invitation.diff')(function* ({ news, olds }) {
    news = news || ({} as InvitationSchema.InvitationProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    // email is immutable
    if (news.email !== olds?.email) return { action: 'replace' }
    return undefined
  }),
})
