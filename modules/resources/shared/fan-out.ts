/**
 * Best-effort tenant fan-out.
 *
 * Every `list` lifecycle that enumerates *across projects* — and the discovery actions that do the
 * same — has one parent whose enumeration can fail without the caller being able to do anything
 * useful about it: `alchemy unsafe nuke` (the only caller of a provider's `list`) must still clean up
 * the projects it *can* see, and failing the whole enumeration over one inaccessible project leaves
 * strictly more behind. That is why the fan-out swallows rather than propagates, and it is declared as
 * such in `makeTenantScopedList`'s own documentation ("best-effort enumeration").
 *
 * What it must **not** do is swallow *silently*. Before 2026-09-25 the per-parent handler was
 * `Effect.catch(() => Effect.succeed([]))`, which made "this parent holds no resources" and "this
 * parent could not be enumerated" the same answer — the class R-06 exists for. The fix is not to
 * propagate (that would abort nuke over one project) but to make the partial result **audible**:
 * `NOT_FOUND` stays quiet, because a parent deleted between the project list and this call is exactly
 * the benign case, and every other code logs a warning naming the parent and the error.
 *
 * Not for *lookups*: a `get`/`getByName` whose result decides whether to create a resource must narrow
 * to `code === 5` and re-raise the rest — an unverified lookup there can create a duplicate
 * (`iam/v1 AccessPermit`'s adopt-by-identity path is the example), and there is no partial result worth
 * preserving.
 *
 * {@link resolveParentIds} is this module's other half: it produces the parents the fan-out
 * enumerates. See its own comment for the one assumption the two share — the *project list* is never
 * best-effort, because an empty answer there means "this tenant has no projects".
 */
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

import * as GrpcUtils from '../../api-client/grpc-utils.ts'
import * as IamGrpc from '../../api-client/iam.ts'
import { MissingTenantIdError, resolveTenantId } from './tenant.ts'

/** Names the parent in the log line: `Skipping <subject> — …`. */
export type FanOutSubject = string

const warnAndEmpty = <A>(
  subject: FanOutSubject,
  error: GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError,
): Effect.Effect<ReadonlyArray<A>, never, never> =>
  Effect.logWarning(
    `Skipping ${subject} — the enumeration failed (${error._tag === 'GrpcError' ? `${error.code} ` : ''}${error.message}), so this result is PARTIAL.`,
  ).pipe(Effect.andThen(Effect.succeed([] as ReadonlyArray<A>)))

/**
 * Run one parent's enumeration, answering `[]` when it fails — quietly for `NOT_FOUND` (the parent is
 * gone) and with a warning that names the parent and the error for anything else.
 *
 * The success type is inferred from the caller's list, so `Effect.forEach` over the parents keeps
 * returning flat attribute arrays.
 */
export const bestEffortList = <A>(
  subject: FanOutSubject,
  list: Effect.Effect<ReadonlyArray<A>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError, never>,
): Effect.Effect<ReadonlyArray<A>, never, never> =>
  list.pipe(
    // Only *typed* failures are swallowed. A defect propagates: a bug in the enumeration is not "one
    // parent that could not be listed", and hiding it is how a fan-out rots.
    Effect.catchTag('GrpcError', (error) =>
      error.code === 5 ? Effect.succeed([] as ReadonlyArray<A>) : warnAndEmpty<A>(subject, error),
    ),
    Effect.catchTag('GrpcDeadlineExceededError', (error) => warnAndEmpty<A>(subject, error)),
  )

/**
 * The parents a tenant fan-out enumerates: with an explicit `parentId` that is the whole answer,
 * otherwise every project in the tenant.
 *
 * Extracted because the same expression — `parentId ? [parentId] : (yield* iam.project.list(tenantId))
 * .map((p) => p.metadata!.id)` — was hand-inlined at 7 call sites (the five `Nebius.vpc.actions.List*`,
 * `Nebius.quotas.actions.ListQuotas`, `Nebius.iam.actions.ListGroups`); it belongs next to
 * {@link bestEffortList}, which consumes its result.
 *
 * ## The tenant is resolved *only* when there is no `parentId`
 *
 * That is deliberate, and it is what `tenant.ts` documents: it "is only needed where something
 * genuinely *lists across projects*". Every call site used to read `NEBIUS_TENANT_ID` eagerly, at
 * action-**construction** time, and so failed a `List*({ parentId })` call — which never touches the
 * tenant — whenever the variable was unset. The short-circuit is therefore a behaviour change for
 * that case, in the direction the tenant module already promised. Pinned in
 * `tests/resources/shared/fan-out.test.ts`.
 *
 * ## The project list is not swallowed
 *
 * Unlike the per-parent enumeration, a failure here is never "one project that could not be listed":
 * it is the whole answer. Narrowing it to `NOT_FOUND` (the tenant is gone) and re-raising the rest is
 * the same classification `iam/actions.ts`'s `ListProjects` makes at the leaf — and `R-06` in
 * ISSUES.md is the rule that a failed enumeration must never read as "nothing there".
 */
export const resolveParentIds = Effect.fn('Nebius.resolveParentIds')(function* (
  parentId: string | undefined,
): Effect.fn.Return<
  ReadonlyArray<string>,
  GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError | Config.ConfigError | MissingTenantIdError,
  IamGrpc.IamGrpcService
> {
  if (parentId) return [parentId]
  const iam = yield* IamGrpc.IamGrpcService
  const tenantId = yield* resolveTenantId()
  const projects = yield* iam.project.list(tenantId)
  return projects.map((project) => project.metadata!.id)
})
