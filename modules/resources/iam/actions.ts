import * as Alchemy from 'alchemy'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as IamGrpc from '../../api-client/iam.ts'
import * as Validation from '../validation.ts'
import * as ProjectModule from './v2/project.ts'
import * as GroupModule from './v1/group.ts'
import type * as Index from './index.ts'
import { resolveTenantId } from '../shared/tenant.ts'
import { bestEffortList, resolveParentIds } from '../shared/fan-out.ts'
import { getOrUndefined } from '../shared/not-found.ts'

// ── Project ───────────────────────────────────────────────────────────────

export const GetProject = Alchemy.Action(
  'Nebius.iam.actions.GetProject',
  Effect.gen(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    return ({ name }: { name: string }) =>
      Effect.gen(function* () {
        const result = yield* getOrUndefined(iam.project.getByName({ parentId: tenantId, name }))
        if (!result) {
          return yield* Effect.fail(
            new Validation.ResourceNotFoundError({
              resourceType: 'project',
              name,
              parent: tenantId,
              message: `No project named "${name}" found in tenant ${tenantId}`,
            }),
          )
        }
        return ProjectModule.toFriendlyAttributes(result)
      })
  }),
)

export const ListProjects = Alchemy.Action(
  'Nebius.iam.actions.ListProjects',
  Effect.gen(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    return () =>
      Effect.gen(function* () {
        const list = yield* iam.project.list(tenantId).pipe(
          Effect.map((items) => items.map((raw) => ProjectModule.toFriendlyAttributes(raw))),
          // The tenant's own project list is not a partial enumeration — nothing was fanned out yet,
          // so a failure here would be reported as "this tenant has no projects". `NOT_FOUND` (the
          // tenant is gone) is the one benign code; everything else must be seen.
          Effect.catchTag('GrpcError', (e) =>
            e.code === 5
              ? Effect.succeed([] as readonly ReturnType<typeof ProjectModule.toFriendlyAttributes>[])
              : Effect.fail(e),
          ),
        )
        return [...list]
      })
  }),
)

// ── Group ─────────────────────────────────────────────────────────────────

export const GetGroup = Alchemy.Action(
  'Nebius.iam.actions.GetGroup',
  Effect.gen(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const defaultProjectId = yield* Config.String('NEBIUS_PROJECT_ID')
    return ({ name, parentId }: { name: string; parentId?: Index.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* getOrUndefined(iam.group.getByName({ parentId: pid, name }))
        if (!result) {
          return yield* Effect.fail(
            new Validation.ResourceNotFoundError({
              resourceType: 'group',
              name,
              parent: pid,
              message: `No group named "${name}" found in project ${pid}`,
            }),
          )
        }
        return GroupModule.toFriendlyAttributes(result)
      })
  }),
)

export const ListGroups = Alchemy.Action(
  'Nebius.iam.actions.ListGroups',
  Effect.gen(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    return ({ parentId }: { parentId?: Index.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = yield* resolveParentIds(parentId)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          bestEffortList(
            `groups in project ${pid}`,
            iam.group.list(pid).pipe(Effect.map((items) => items.map((raw) => GroupModule.toFriendlyAttributes(raw)))),
          ),
        )
        return results.flat()
      })
  }),
)
