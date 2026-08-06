import * as Effect from 'effect/Effect'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusAccessPermitSchema from '../../../../schemas/nebius/iam/v1/access_permit.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as AccessPermitSchema from './access-permit.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusAccessPermit = Alchemy.Resource<
  'Nebius.iam.v1.AccessPermit',
  AccessPermitSchema.AccessPermitProps,
  AccessPermitSchema.AccessPermitAttributes
>

export const NebiusAccessPermit = Alchemy.Resource<NebiusAccessPermit>('Nebius.iam.v1.AccessPermit')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusAccessPermitSchema.AccessPermit,
): AccessPermitSchema.AccessPermitAttributes =>
  ResourceUtils.toFriendlyAttributes<AccessPermitSchema.AccessPermitAttributes>({
    rawResource: raw,
    resourceSchema: NebiusAccessPermitSchema.AccessPermit,
  })

// ----- PROVIDER

export const NebiusAccessPermitProvider = AlchemyProvider.succeed(NebiusAccessPermit, {
  reconcile: Effect.fn('Nebius.iam.v1.AccessPermit.reconcile')(function* ({ id, news, output, session }) {
    news = yield* AccessPermitSchema.validateAccessPermitProps(news)

    const iam = yield* IamGrpc.IamGrpcService

    let permit: NebiusAccessPermitSchema.AccessPermit | undefined
    if (output?.id) {
      permit = yield* iam.accessPermit
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!permit) {
      // Check for existing permit with same (parentId, resourceId, role) to avoid duplicates
      const existingPermits = yield* iam.accessPermit.list(news.parentId).pipe(
        Effect.catch(() =>
          Effect.succeed([] as ReadonlyArray<NebiusAccessPermitSchema.AccessPermit>),
        ),
      )
      const existing = existingPermits.find(
        (p) => p.spec?.resourceId === news.resourceId && p.spec?.role === news.role,
      )
      if (existing) {
        return toFriendlyAttributes(existing)
      }

      const name = `ap-${id.replace(/_/g, '-').toLowerCase().slice(0, 55)}`
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.iam.v1.AccessPermit (${name})`)
      permit = yield* iam.accessPermit.create({
        // Nebius IAM rejects metadata.name on AccessPermit creates (verified
        // live — same API rule as GroupMembership). The name is only used as
        // the physical resource name locally; omit it from the request.
        metadata: { parentId: news.parentId, labels },
        spec: NebiusAccessPermitSchema.AccessPermitSpec.fromJSON({
          resourceId: news.resourceId,
          role: news.role,
        }),
      })
    }

    // AccessPermit spec is fully immutable — nothing to update
    return toFriendlyAttributes(permit)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v1.AccessPermit',
    resourceLabel: 'AccessPermit',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.accessPermit.delete(id),
  }),

  read: Effect.fn('Nebius.iam.v1.AccessPermit.read')(function* ({ id, output }) {
    if (!output?.id) return undefined
    const iam = yield* IamGrpc.IamGrpcService
    const permit = yield* iam.accessPermit
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    if (!permit) return undefined
    const attrs = toFriendlyAttributes(permit)
    if (yield* AlchemyTags.hasAlchemyTags(id, permit.metadata?.labels || {})) {
      return attrs
    }
    return Alchemy.AdoptPolicy.Unowned(attrs)
  }),

  // list is per-group (parentId from props), not project-scoped — return []
  list: Effect.fn('Nebius.iam.v1.AccessPermit.list')(() => Effect.succeed([])),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v1.AccessPermit.diff')(function* ({ news, olds }) {
    news = news || ({} as AccessPermitSchema.AccessPermitProps)
    if (!AlchemyDiff.isResolved(news)) return undefined
    // resourceId, role, and parentId are all immutable
    if (news.resourceId !== olds?.resourceId) return { action: 'replace' }
    if (news.role !== olds?.role) return { action: 'replace' }
    if (news.parentId !== olds?.parentId) return { action: 'replace' }
    return undefined
  }),
})
