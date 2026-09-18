import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Alchemy from 'alchemy'
import * as AlchemyTags from 'alchemy/Tags'
import type { GrpcError, GrpcDeadlineExceededError } from '../api-client/grpc-utils.ts'
import { GrpcError as GrpcErrorCtor } from '../api-client/grpc-utils.ts'
import type { PropsValidationError } from './validation.ts'
import { resolveTenantId } from './shared/tenant.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal structural contract that every protobuf resource satisfies. */
interface HasMetadata {
  metadata?: { labels?: Record<string, string> }
}

/**
 * Nebius default resources are identified by:
 * - name prefix `default-` (e.g. default-project-eu-west1)
 * - known default names (e.g. `mlflow-sa` auto-created per project)
 * - `status.default: true`
 * - no `alchemy::`-prefixed labels (system-provisioned resources untouched by Alchemy)
 *
 * Resources carrying `alchemy::` ownership labels are never considered defaults.
 */
const DEFAULT_RESOURCE_NAMES = new Set(['mlflow-sa'])

const isDefaultResource = (raw: unknown): boolean => {
  const record = raw as {
    metadata?: { name?: string; labels?: Record<string, string> }
    status?: { default?: boolean }
  }

  const labels = record.metadata?.labels
  const hasAlchemyLabels = labels !== undefined && Object.keys(labels).some((k) => k.startsWith('alchemy::'))

  // Resources with Alchemy ownership labels are never defaults
  if (hasAlchemyLabels) return false

  // Resources without Alchemy labels that match any default pattern are flagged
  const name = record.metadata?.name
  if (name?.startsWith('default-') === true) return true
  if (name !== undefined && DEFAULT_RESOURCE_NAMES.has(name)) return true
  if (record.status?.default === true) return true

  // System resources untouched by Alchemy have no labels → default
  if (labels === undefined || Object.keys(labels).length === 0) return true

  return false
}

/** Extract the service shape from a `Context.Service` tag. */
// oxlint-disable-next-line typescript/no-explicit-any — approved: Context.Service wildcard generic
type ServiceOf<T> = T extends Context.Service<any, infer S> ? S : never

// ---------------------------------------------------------------------------
// makeCrudRead
// ---------------------------------------------------------------------------

/**
 * Create a standard `read` lifecycle operation.
 *
 * Fetches the resource by physical ID, returns `undefined` on 404,
 * and wraps foreign resources in {@link Alchemy.AdoptPolicy.Unowned}.
 *
 * `service` is the gRPC service tag (e.g. `StorageGrpcService`) —
 * the factory yields it internally and passes the resolved instance
 * to `getById`.
 */
// oxlint-disable-next-line typescript/no-explicit-any — approved: Context.Service wildcard generics
export const makeCrudRead = <STag extends Context.Service<any, any>, Raw extends HasMetadata, Attrs extends object>(config: {
  resourceName: string
  /** gRPC service tag, e.g. {@link StorageGrpcService}. */
  service: STag
  /** Accessor: (resolved service, id) → typed get call. */
  getById: (svc: ServiceOf<STag>, id: string) => Effect.Effect<Raw, GrpcError | GrpcDeadlineExceededError>
  /** Convert raw proto resource to friendly attributes. */
  toAttrs: (raw: Raw) => Attrs
  /**
   * Plan-time props validator (e.g. `SubnetSchema.validateSubnetProps`).
   *
   * Runs on the greenfield/adoption-probe path only — see the note in the
   * `read` body — so `alchemy plan` fails fast on props the API would reject
   * or hang on, instead of deferring the error to reconcile (deploy).
   */
  validate?: (news: unknown) => Effect.Effect<unknown, PropsValidationError, unknown>
}) =>
  Effect.fn(`${config.resourceName}.read`)(function* ({
    id,
    olds: props,
    output,
  }: {
    id: string
    /** Desired props. Alchemy names this field `olds` on the `read` input. */
    olds?: unknown
    output?: { id: string }
  }) {
    if (!output?.id) {
      // Greenfield path: no persisted state, so the resource may not exist yet.
      //
      // alchemy calls `read` here as an adoption probe, and it is the ONLY
      // provider hook invoked for a resource with no persisted row — `Plan.ts`
      // short-circuits with `if (!oldState || oldState.status === "creating")
      // return resourceExpr` *before* reaching `provider.diff`. Validating the
      // desired props here is therefore what makes `alchemy plan` fail fast on
      // greenfield resources; validating only in `diff()` covers updates alone.
      //
      // NB: the interrupted-create recovery path in `Apply.ts`
      // (`collectGarbage`) also calls `read` with no `output`, so this can fire
      // during teardown. It is deliberately narrow — it triggers only for rows
      // whose `attr` is undefined, i.e. a create that died before returning
      // attributes — which is why validation is confined to this branch rather
      // than widened to every `read`.
      if (config.validate && props != null) yield* config.validate(props)
      return undefined
    }
    const svc = yield* config.service
    const resource = yield* config.getById(svc, output.id).pipe(
      Effect.catchTag('GrpcError', (e) =>
        e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e),
      ),
    )
    if (!resource) return undefined
    const attrs = config.toAttrs(resource)
    if (yield* AlchemyTags.hasAlchemyTags(id, resource.metadata?.labels || {})) {
      return attrs
    }
    return Alchemy.AdoptPolicy.Unowned(attrs)
  })

// ---------------------------------------------------------------------------
// makeCrudDelete
// ---------------------------------------------------------------------------

/**
 * Create a standard `delete` lifecycle operation.
 *
 * Deletes the resource by physical ID. Designed to be idempotent —
 * if the resource doesn't exist, the API will return a 404 which the
 * caller should handle via {@link Effect.catchTag}.
 *
 * `service` is the gRPC service tag — the factory yields it and
 * passes the resolved instance to `deleteById`.
 */
// oxlint-disable-next-line typescript/no-explicit-any — approved: Context.Service wildcard generics
export const makeCrudDelete = <STag extends Context.Service<any, any>, E>(config: {
  resourceName: string
  /** gRPC service tag, e.g. {@link StorageGrpcService}. */
  service: STag
  /** Accessor: (resolved service, id) → typed delete call. */
  deleteById: (svc: ServiceOf<STag>, id: string) => Effect.Effect<void, E>
  /** Human-readable resource label for progress notes (e.g. "Bucket", "Instance"). */
  resourceLabel?: string
}) =>
  // oxlint-disable-next-line typescript/no-explicit-any — approved: Alchemy Session type not exported
  Effect.fn(`${config.resourceName}.delete`)(function* ({ output, session }: { output: { id: string }; session: any }) {
    if (config.resourceLabel && output?.id) {
      yield* session.note(`Deleting ${config.resourceLabel} (${output.id})`)
    }
    const svc = yield* config.service
    const started = yield* Clock.currentTimeMillis
    // The delete operation (e.g. tearing down a VM-backed endpoint) is polled
    // to completion and can take minutes — race it with a progress ticker so
    // the session shows the deploy is still working instead of falling silent.
    // The first tick is at 30s, so fast deletes emit nothing extra; the ticker
    // is interrupted when the delete finishes (or fails).
    yield* Effect.race(
      // Idempotent delete: NOT_FOUND means the resource is already gone (it may
      // have been cascaded away by the server, e.g. deleting a service account
      // removes its group memberships and access keys) — treat it as success.
      config.deleteById(svc, output.id).pipe(
        Effect.catchIf(
          // oxlint-disable-next-line no-explicit-any — error type is generic over E
          (e: any): e is GrpcError => e instanceof GrpcErrorCtor && e.code === 5,
          () => Effect.void,
        ),
      ),
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(30_000)
          const elapsedSec = Math.round(((yield* Clock.currentTimeMillis) - started) / 1000)
          yield* session.note(`Still deleting ${config.resourceLabel ?? 'resource'} (${output.id}) — ${elapsedSec}s elapsed`)
        }
      }),
    )
  })

// ---------------------------------------------------------------------------
// makeTenantScopedList
// ---------------------------------------------------------------------------

/**
 * Create a tenant-scoped `list` lifecycle for nuke coverage across all
 * projects.
 *
 * Enumerates every project under the tenant via IAM and fans out to
 * each, so nuke catches resources in custom projects. Per-project
 * errors are silently swallowed (best-effort enumeration).
 */
// oxlint-disable typescript/no-explicit-any — approved: Context.Service wildcard generics
export const makeTenantScopedList = <
  STag extends Context.Service<any, any>,
  IamTag extends Context.Service<any, any>,
  RawProject,
  Raw,
  Attrs extends object,
>(config: {
  resourceName: string
  /** gRPC service tag for the resource type. */
  service: STag
  /** IAM gRPC service tag for enumerating projects. */
  iamService: IamTag
  /** Environment variable for the tenant ID. Default: `"NEBIUS_TENANT_ID"`. */
  tenantEnvVar?: string
  /** Accessor: (resolved IAM service, tenantId) → list of projects. */
  projectList: (
    iam: ServiceOf<IamTag>,
    tenantId: string,
  ) => Effect.Effect<ReadonlyArray<RawProject>, GrpcError | GrpcDeadlineExceededError>
  /** Extract the project id from a project returned by {@link projectList}. */
  projectId: (project: RawProject) => string
  /** Accessor: (resolved service, parentId) → typed list call. */
  listByParent: (
    svc: ServiceOf<STag>,
    parentId: string,
  ) => Effect.Effect<ReadonlyArray<Raw>, GrpcError | GrpcDeadlineExceededError>
  /** Convert raw proto resource to friendly attributes. */
  toAttrs: (raw: Raw) => Attrs
}) =>
  // oxlint-enable typescript/no-explicit-any
  Effect.fn(`${config.resourceName}.list`)(function* () {
    const svc = yield* config.service
    const iam = yield* config.iamService
    const tenant = yield* resolveTenantId(config.tenantEnvVar)
    const projects = yield* config.projectList(iam, tenant)
    const allResults = yield* Effect.forEach(projects, (project) =>
      config.listByParent(svc, config.projectId(project)).pipe(
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<Raw>)),
      ),
    )
    const results = allResults
      .flat()
      .filter((r) => !isDefaultResource(r))
    return results.map(config.toAttrs)
  })
// ---------------------------------------------------------------------------

/**
 * Returns `{ action: 'replace' }` when the resource's **identity** — its parent
 * and its physical name — changed.
 *
 * Both are immutable: Nebius names are unique *per parent*, and no update RPC
 * moves a resource between parents. A change means a new resource.
 *
 * Create-first is correct in both cases (the replacement's identity differs), so
 * this returns a plain replace — do not route it through
 * {@link replaceKeepingName}.
 *
 * `parentId` is compared only when BOTH sides carry one: props leave it optional
 * and fall back to `NEBIUS_PROJECT_ID` at reconcile time, so `undefined → set`
 * usually means "now written down explicitly", not "moved". A genuine move that
 * goes unplanned this way still surfaces loudly — reconcile sends
 * `metadata.parentId` on every update, so the API rejects a cross-project
 * update rather than silently keeping the resource where it was.
 */
export const identityChangeRequiresReplace = (
  news: { name?: string; parentId?: string },
  olds?: { name?: string; parentId?: string },
): { action: 'replace' } | undefined =>
  news.name !== olds?.name ||
  (news.parentId !== undefined && olds?.parentId !== undefined && news.parentId !== olds.parentId)
    ? { action: 'replace' }
    : undefined

// ---------------------------------------------------------------------------
// Replace ordering — create-first vs delete-first
// ---------------------------------------------------------------------------
//
// Alchemy's default replace is **create-first**: the new generation is created,
// then Phase-2 GC deletes the old one. That is safe only while the two
// generations can COEXIST. The framework guarantees the *teardown* ordering for
// references it can see (`Output.upstreamAny` walks props recursively, and GC
// deletes dependents before dependencies — "Dependents (`downstream`) are
// deleted before this resource", Apply.ts), so the provider's only job is to
// pick the ordering that lets the create succeed.
//
// A resource's identity is (parent, physical name). Three cases:
//
//  1. `name` changed        → create-first. The new generation has a different
//                             name, so the two coexist safely.
//                             (`identityChangeRequiresReplace` above.)
//  2. parent changed        → create-first. Different parent, so the identity
//                             differs even when the name is reused (Nebius
//                             uniqueness is per-parent).
//  3. spec-only change      → the identity is REUSED:
//       a. `props.name` absent → still create-first: `createPhysicalName`
//          seeds its random suffix from the per-resource `InstanceId`, and a
//          replace mints a FRESH one (Apply.ts), so a generated name differs.
//       b. `props.name` pinned → the same name is minted again → the create
//          hits ALREADY_EXISTS (code 6). Must be `deleteFirst`.
//
// `deleteFirst` deletes the old generation inside THIS resource's node, which
// runs before its dependents' nodes (apply order is dependency-first), so old
// dependents still reference the old id at that instant. That is fine while the
// API merely tolerates the dangling reference for that window (Nebius ids are
// opaque strings) — a parent whose API forbids it needs a pre-check instead
// (see TASKS.md §"same-name replace").

/**
 * The replace action for a **spec-only** change (case 3): the identity —
 * parent and name — is unchanged, so a pinned `name` cannot be created while
 * the old generation still holds it.
 *
 * Use this for every immutable-field replace that is NOT a name or parent
 * change. Behaviour is unchanged for resources without a pinned name (still
 * create-first), so this only fixes the currently-broken case.
 */
export const replaceKeepingName = (
  news: { name?: string },
): { action: 'replace' } | { action: 'replace'; deleteFirst: true } =>
  news.name === undefined ? { action: 'replace' } : { action: 'replace', deleteFirst: true }

/**
 * The replace action for a spec-only change on a resource whose physical name is
 * **derived from its logical id** (e.g. `ak-<logicalId>`), so every generation
 * asks for the SAME name no matter what the props say — create-first can never
 * succeed.
 *
 * Only for such deterministic names. A resource whose name is
 * `props.name ?? createPhysicalName(...)` wants `replaceKeepingName` instead.
 */
export const replaceSameGeneratedName = (): { action: 'replace'; deleteFirst: true } => ({
  action: 'replace',
  deleteFirst: true,
})
