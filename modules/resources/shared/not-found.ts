/**
 * The `get`/`getByName` lookup that turns **`NOT_FOUND` into `undefined`**, and nothing else.
 *
 * ## Why this is one function and not 62 copies
 *
 * The expression it replaces —
 *
 * ```ts
 * .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
 * ```
 *
 * — was hand-written at 62 call sites (`npx fallow dupes` lists it as the largest clone family in
 * `modules/`). It is the second of the three shapes R-06 defines for a lookup, and the one where a
 * mistake is silent:
 *
 * - **`getOrUndefined` (this)** — a `get` whose answer decides whether to *create*. `NOT_FOUND` is
 *   "absent, go ahead"; every other code must re-raise, because an unverified lookup is
 *   indistinguishable from "no such resource exists" and the branch below it would create a
 *   **duplicate** (`iam/v1 AccessPermit`'s adopt-by-identity path).
 * - **`bestEffortList`** (`fan-out.ts`) — an enumeration across parents, where one inaccessible parent
 *   must not abort the whole fan-out, so a partial result is returned **and logged**.
 * - **`Effect.ignore({ log, message })`** — a best-effort pre-step in a destroy, where a blocked
 *   delete would cascade into leaked parents.
 *
 * Keeping the rule in one place is what makes it reviewable: the 62 sites each said `code === 5` and
 * each could have drifted. It is deliberately *not* a `catch` of any failure, which is the class R-06
 * exists for — "a failure must not read as 'nothing there'".
 *
 * Not the right tool for a **write** (`delete`, `update`): `NOT_FOUND` there means "already gone", and
 * the value it would produce is meaningless. Those are `catchIf`/`Effect.void` or, in
 * `factory.ts`'s `makeCrudDelete`, a documented idempotent delete.
 */
import * as Effect from 'effect/Effect'

import * as GrpcUtils from '../../api-client/grpc-utils.ts'

/**
 * Whether a value is an error tagged `GrpcError`.
 *
 * **Tag-based on purpose**, matching `Effect.catchTag` — which is what the 62 sites this module
 * replaced used, and what this repo's structural gRPC mocks rely on: `tests/helpers/mocks.ts` fakes a
 * service with plain `{ _tag: 'GrpcError', code: 5 }` objects, so an `instanceof` check (the shape
 * `factory.ts`'s idempotent delete uses, where the error arrives as `unknown` with no tag to read)
 * would let those escape the handler — measured: it broke
 * `tests/resources/quotas/v1/unit.test.ts`'s NOT_FOUND case before this note was written.
 */
const isGrpcError = (error: unknown): error is GrpcUtils.GrpcError =>
  typeof error === 'object' && error !== null && (error as { readonly _tag?: unknown })._tag === 'GrpcError'

/**
 * Whether a value is gRPC `NOT_FOUND` (code 5).
 *
 * A `Refinement` rather than a `Predicate` so it can be used where the narrowed type is needed —
 * `Effect.catchIf(someUnknownEffect, isNotFound, …)`, or a `while:` retry condition.
 */
export const isNotFound = (error: unknown): error is GrpcUtils.GrpcError =>
  isGrpcError(error) && error.code === 5

/**
 * `NOT_FOUND` answers `undefined`; every other failure — and every defect — propagates untouched.
 *
 * The error channel is **unchanged**, not widened or narrowed: the input already carries `GrpcError`,
 * so the re-raised case leaves the same type behind while the success type gains `undefined`.
 *
 * Not `Option.getOrUndefined` — that unwarps an `Option` (this codebase already uses it,
 * `capacity/v1/actions.ts:248`); this one turns a *failed lookup* into `undefined`.
 *
 * ```ts
 * let network: NebiusNetworkSchema.Network | undefined
 * if (output?.id) {
 *   network = yield* getOrUndefined(vpcGrpcService.network.get(output.id))
 * }
 * ```
 */
export const getOrUndefined = <A, E, R>(
  effect: Effect.Effect<A, E | GrpcUtils.GrpcError, R>,
): Effect.Effect<A | undefined, E | GrpcUtils.GrpcError, R> =>
  // `catchIf` with a refinement rather than `catchTag` with a code test: the error channel here is
  // generic over `E`, and only a `Refinement` keeps `GrpcError` visible inside the handler.
  Effect.catchIf(effect, isNotFound, () => Effect.succeed(undefined))
