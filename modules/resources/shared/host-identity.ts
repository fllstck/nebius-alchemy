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
import * as Schema from 'effect/Schema'
import * as Iam from '../iam/index.ts'
import * as GroupSchema from '../iam/v1/group.schema.ts'
import * as ServiceAccountSchema from '../iam/v1/service-account.schema.ts'

/** The per-host credential bundle every binding injects into the Worker env. */
export class HostIdentity extends Schema.Class<HostIdentity>('nebius/bindings/HostIdentity')({
  serviceAccountId: ServiceAccountSchema.ServiceAccountId,
  groupId: GroupSchema.GroupId,
  /** The AWS-compatible access key ID (S3 credentials). */
  awsAccessKeyId: Schema.String,
  /** The one-time secret access key. Only available at creation time. */
  secretAccessKey: Schema.String,
}) {}

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
 * Lazily declare (or adopt) the per-host identity: a ServiceAccount holding an
 * S3-compatible AccessKey, placed in a Group so capability-specific grants
 * (e.g. an AccessPermit on a bucket) can attach later.
 */
export const hostIdentity = Effect.fn('hostIdentity')(function* (
  hostLogicalId: string,
): Effect.fn.Return<HostIdentity> {
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

  return new HostIdentity({
    serviceAccountId: yield* yield* sa.id,
    groupId: yield* yield* group.id,
    awsAccessKeyId: yield* yield* key.awsAccessKeyId,
    secretAccessKey: yield* yield* key.secretAccessKey,
  })
})

/**
 * Grant a role on a bucket to the host-identity group (D5).
 *
 * Declared lazily by a binding, keyed on (host, bucket) so two hosts binding
 * the same bucket get distinct permits. The `iam.AccessPermit` resource
 * dedupes by (parentId, resourceId, role) server-side (provider list check),
 * so re-deploys adopt the existing permit instead of duplicating.
 */
export const grantBucketAccess = Effect.fn('grantBucketAccess')(function* (
  logicalId: string,
  identity: HostIdentity,
  bucketId: string,
  role: string,
): Effect.fn.Return<void> {
  yield* unrequiring(
    Iam.AccessPermit(logicalId, {
      parentId: identity.groupId,
      resourceId: bucketId,
      role,
    }),
  )
})
