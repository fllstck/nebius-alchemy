/**
 * M1 — deploy-time host identity provisioning (D3 + D8).
 *
 * ⚠️ DEPLOY-TIME ONLY. This module statically imports the Nebius IAM resources,
 * whose providers depend on `@grpc/grpc-js` (Node-only). It must NEVER be
 * statically imported by a binding module: bindings load it via a guarded
 * `await import()` inside `if (!globalThis.__ALCHEMY_RUNTIME__)`, which
 * alchemy's bundler folds + DCEs out of Worker bundles entirely (M0-verified:
 * 67 KB bundle, zero gRPC markers).
 *
 * The identity is keyed on the host's LogicalId so it is stable across deploys:
 * the AccessKey's one-time secret is captured at creation (`precreate`) and
 * preserved in Alchemy state, so every deploy re-injects the same credentials.
 *
 * @internal — consumed via dynamic import from binding modules only.
 */
import * as Effect from 'effect/Effect'
import * as Output from 'alchemy/Output'
import * as AlchemyNamespace from 'alchemy/Namespace'
import * as Iam from '../iam/index.ts'
import * as IamIds from '../iam/v1/ids.ts'

/**
 * Erase the deploy-time Provider requirements of lazily-declared resources.
 *
 * The Binding.Service contract types binding impl fns with `R = never` (same
 * as alchemy's own bindings — cf. the R2 `BucketHttp` d.ts, whose fn declares
 * `AccountApiToken` yet is typed `Effect<..., never, never>`). The Provider
 * requirements are REAL at deploy time but are satisfied by the stack's
 * provider collection (`Nebius.providers()`), so this cast is runtime-correct:
 * it only opts out of the type-level check. Encapsulated `any` — approved
 * exception (same spirit as `callMethod<T>()`).
 */
// oxlint-disable-next-line no-explicit-any
const unrequiring = <A>(effect: Effect.Effect<A, never, any>): Effect.Effect<A, never, never> =>
  effect as Effect.Effect<A, never, never>

/**
 * The per-host credential bundle every binding injects into the Worker env.
 *
 * Values are the lazily-declared resources' OUTPUT expressions, NOT resolved
 * strings: resolving them inline (`yield* yield* sa.id`) hangs / returns
 * undefined inside a binding impl (the ambient RuntimeContext during a
 * resource lifecycle is not the resolve context). alchemy resolves Outputs
 * where they're consumed — Input props (AccessPermit) and binding data
 * (host.bind) are both run through `Output.evaluate` at apply time.
 */
export interface HostIdentity {
  /** The host's service account id. */
  serviceAccountId: Output.Output<IamIds.ServiceAccountId>
  /** The host's group id (grant subject). */
  groupId: Output.Output<IamIds.GroupId>
  /** The AWS-compatible access key ID (S3 credentials). */
  awsAccessKeyId: Output.Output<string>
  /** The one-time secret access key. Only available at creation time. */
  secretAccessKey: Output.Output<string>
}

/**
 * Lazily declare (or adopt) the per-host identity: a ServiceAccount holding an
 * S3-compatible AccessKey, placed in a Group so capability-specific grants
 * (e.g. an AccessPermit on a bucket) can attach later.
 *
 * The identity is pinned ABSOLUTELY to the host's own namespace
 * (`<host>/<host>BindingSA`) rather than the caller's ambient one, because the
 * same host is a binding target from more than one call site:
 * `transformInstanceProps` (already inside `Namespace.push(id)`) and the binding
 * impl itself (at the root, or inside whatever namespace the user called from).
 * Leaving it ambient produced two DIFFERENT FQNs for one host, so the identity
 * was declared twice — two SAs, two groups and two AccessKeys with the same
 * physical name, the second dying with ALREADY_EXISTS (`AccessKeyCollisionError`
 * on real infra, 2026-09-10). With the namespace pinned, both call sites
 * resolve to the same FQN and the framework's duplicate-FQN registration makes
 * it a single identity.
 */
export const hostIdentity = Effect.fn('hostIdentity')(function* (
  hostLogicalId: string,
): Effect.fn.Return<HostIdentity> {
  return yield* Effect.gen(function* () {
    const sa = yield* unrequiring(
      Iam.ServiceAccount(`${hostLogicalId}BindingSA`, {
        description: 'Alchemy binding host identity',
      }),
    )
    const group = yield* unrequiring(Iam.Group(`${hostLogicalId}BindingGroup`))
    yield* unrequiring(
      Iam.GroupMembership(`${hostLogicalId}BindingMembership`, {
        parentId: group.id,
        memberId: sa.id,
      }),
    )
    const key = yield* unrequiring(
      Iam.AccessKey(`${hostLogicalId}BindingKey`, {
        serviceAccountId: sa.id,
        secretDeliveryMode: 'INLINE',
      }),
    )

    return {
      serviceAccountId: sa.id,
      groupId: group.id,
      awsAccessKeyId: key.awsAccessKeyId,
      secretAccessKey: key.secretAccessKey,
    }
  }).pipe(
    // `set` replaces the ambient namespace ABSOLUTELY (no parent), so both call
    // sites land on the same FQNs.
    AlchemyNamespace.set(hostLogicalId),
  )
})

/**
 * Grant a role on a bucket to the host-identity group (D5).
 *
 * Declared lazily by a binding, keyed on (host, bucket) so two hosts binding
 * the same bucket get distinct permits. The `iam.AccessPermit` resource
 * dedupes by (parentId, resourceId, role) server-side (provider list check),
 * so re-deploys adopt the existing permit instead of duplicating.
 *
 * `identity` and `bucketId` are Output expressions (see {@link HostIdentity});
 * the AccessPermit props (Input) resolve them at apply time.
 */
export const grantBucketAccess = Effect.fn('grantBucketAccess')(function* (
  logicalId: string,
  identity: HostIdentity,
  bucketId: Output.Output<string>,
  role: string,
): Effect.fn.Return<void> {
  yield* unrequiring(
    Iam.AccessPermit(logicalId, {
      parentId: identity.groupId,
      // A permit target is polymorphic (its own nominal brand): convert the
      // concrete bucket id explicitly instead of leaking a plain string.
      resourceId: Output.map(bucketId, (value) => IamIds.AccessPermitResourceId.make(value)),
      role,
    }),
  )
})
