import * as Alchemy from 'alchemy'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as IamGrpc from '../../api-client/iam.ts'
import * as Validation from '../validation.ts'
import * as ProjectModule from './v2/project.ts'
import * as GroupModule from './v1/group.ts'
import type * as Index from './index.ts'
import { resolveTenantId } from '../shared/tenant.ts'

// ── Project ───────────────────────────────────────────────────────────────

export const GetProject = Alchemy.Action(
  'Nebius.iam.actions.GetProject',
  Effect.gen(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    return ({ name }: { name: string }) =>
      Effect.gen(function* () {
        const result = yield* iam.project
          .getByName({ parentId: tenantId, name })
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
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
          Effect.catch(() => Effect.succeed([] as readonly ReturnType<typeof ProjectModule.toFriendlyAttributes>[])),
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
    const defaultProjectId = yield* Config.string('NEBIUS_PROJECT_ID')
    return ({ name, parentId }: { name: string; parentId?: Index.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* iam.group
          .getByName({ parentId: pid, name })
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
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
    const tenantId = yield* resolveTenantId()
    return ({ parentId }: { parentId?: Index.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = parentId ? [parentId] : (yield* iam.project.list(tenantId)).map((p) => p.metadata!.id)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          iam.group.list(pid).pipe(
            Effect.map((items) => items.map((raw) => GroupModule.toFriendlyAttributes(raw))),
            Effect.catch(() => Effect.succeed([] as readonly ReturnType<typeof GroupModule.toFriendlyAttributes>[])),
          ),
        )
        return results.flat()
      })
  }),
)
