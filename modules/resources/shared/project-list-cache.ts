/**
 * The tenant's project list, fetched **once** per credential session (R-12).
 *
 * `IamGrpcService.project.list` is the input side of every tenant fan-out: it is called by the 30
 * `makeTenantScopedList` lifecycles, the seven bespoke two-level ones (`mk8s NodeGroup`,
 * `mysterybox SecretVersion`, `dns Record`, `vpc Route`, `vpc SecurityRule`, `iam AccessPermit`,
 * `iam GroupMembership`), `iam FederationCertificate`'s federation fan-out, the `List*` discovery
 * actions, and `Nebius.iam.v2.Project.list` itself — 41 call sites under `modules/`. `alchemy unsafe
 * nuke` runs *every* provider's `list`, so without memoization that is one identical tenant-wide list
 * RPC per family: `41 × (1 + M)` requests where `41 × M` are unavoidable and `41` are pure
 * duplication.
 *
 * ## A layer decorator, not a service of its own
 *
 * Nothing at a call site had to change: `providers()` provides this layer instead of
 * `IamGrpcServiceLive`, so every consumer of `IamGrpcService` — including code written before the
 * cache — goes through it. Only `project.list` is memoized; every other member is the raw service,
 * re-spread untouched, so a member the interface gains later is inherited rather than silently
 * missing.
 *
 * ## Why not a bare `Effect.cached`
 *
 * Two properties the single-effect form cannot give:
 *
 * - **Keyed by tenant.** The key is the `tenantId` argument, not the layer, so a process that reads
 *   two tenants (a test running several layers, or a future multi-tenant run) does not cross-talk.
 * - **Failures are not cached.** The TTL is `Duration.infinity` for a success and `Duration.zero` for
 *   a failure, so a transient `UNAVAILABLE` is retried by the next caller instead of poisoning the
 *   whole nuke with one cached error. A *successful* list is stable for the session — the lifetime of
 *   a deploy, which is exactly the assumption `fan-out.ts` documents.
 *
 * Single-flight comes with the same primitive: concurrent callers of a missing key share one in-flight
 * lookup, which is what makes 41 families arriving at once issue **one** request rather than 41.
 *
 * ## Not warmed, not invalidated
 *
 * The cache is lazy and never invalidated, so a project created *during* this process is not in the
 * cached list. None of the readers can see that: a `list` is either nuke (which does not create) or a
 * user-invoked discovery action, and no deploy path enumerates projects after creating one. If a
 * caller ever does both — `Nebius.iam.actions.ListProjects` after a `Project` in one run — invalidate
 * where the project is created rather than shortening the TTL, which would only re-fetch the same
 * unchanged list.
 */
import * as Cache from 'effect/Cache'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'

import * as IamGrpc from '../../api-client/iam.ts'

/**
 * One entry per tenant read by this layer. A deploy reads exactly one; the headroom is for a test (or
 * a future multi-tenant run) that reads more, since an evicted entry would just be re-fetched.
 */
export const PROJECT_LIST_CACHE_CAPACITY = 8

/**
 * `IamGrpcService` with `project.list` memoized per tenant. See the module comment for why the
 * lifetime is the session and why a failure is not cached.
 */
export const IamGrpcServiceWithProjectListCache: Layer.Layer<
  IamGrpc.IamGrpcService,
  never,
  IamGrpc.IamGrpcService
> = Layer.effect(
  IamGrpc.IamGrpcService,
  Effect.gen(function* () {
    const iam = yield* IamGrpc.IamGrpcService
    const cache = yield* Cache.makeWith((tenantId: string) => iam.project.list(tenantId), {
      capacity: PROJECT_LIST_CACHE_CAPACITY,
      // Only a success is kept: `Duration.zero` makes `Cache` drop a failed entry immediately (so the
      // next caller re-fetches) while still sharing the failure with the callers that were already
      // waiting on it.
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    })

    return {
      ...iam,
      project: {
        ...iam.project,
        list: (tenantId: string) => Cache.get(cache, tenantId),
      },
    }
  }),
)
