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
import type { Provider } from 'alchemy/Provider'
import * as Iam from '../iam/index.ts'
import type {
  GroupMembershipResource,
  GroupResource,
  ServiceAccountResource,
} from '../iam/v1/index.ts'
import type { AccessKeyResource } from '../iam/v2/index.ts'

/**
 * The per-host credential bundle every binding injects into the Worker env.
 *
 * NOTE: `secretAccessKey` is a plain string here because `Schema.Redacted`
 * decode expects an already-Redacted value (and encodes to the "<redacted>"
 * marker). This model is ephemeral — never persisted — so Redacted wrapping
 * happens at the env boundary instead (M2: `Redacted.make(...)` before
 * `bindWorkerEnv`, which maps Redacted values to Cloudflare `secret_text`).
 */
export class HostIdentity extends Schema.Class<HostIdentity>('nebius/bindings/HostIdentity')({
  serviceAccountId: Schema.String,
  groupId: Schema.String,
  /** The AWS-compatible access key ID (S3 credentials). */
  awsAccessKeyId: Schema.String,
  /** The one-time secret access key. Only available at creation time. */
  secretAccessKey: Schema.String,
}) {}

/**
 * Lazily declare (or adopt) the per-host identity: a ServiceAccount holding an
 * S3-compatible AccessKey, placed in a Group so capability-specific grants
 * (e.g. a bucket-policy group grant) can attach later.
 */
export const hostIdentity = Effect.fn('hostIdentity')(function* (
  hostLogicalId: string,
): Effect.fn.Return<
  HostIdentity,
  never,
  | Provider<ServiceAccountResource>
  | Provider<GroupResource>
  | Provider<GroupMembershipResource>
  | Provider<AccessKeyResource>
> {
  const sa = yield* Iam.ServiceAccount(`${hostLogicalId}BindingSA`, {
    description: 'Alchemy binding host identity',
  })
  const group = yield* Iam.Group(`${hostLogicalId}BindingGroup`)
  yield* Iam.GroupMembership(`${hostLogicalId}BindingMembership`, {
    parentId: group.id,
    memberId: sa.id,
  })
  const key = yield* Iam.AccessKey(`${hostLogicalId}BindingKey`, {
    serviceAccountId: sa.id,
    secretDeliveryMode: 'INLINE',
  })

  return new HostIdentity({
    serviceAccountId: yield* yield* sa.id,
    groupId: yield* yield* group.id,
    awsAccessKeyId: yield* yield* key.awsAccessKeyId,
    secretAccessKey: yield* yield* key.secretAccessKey,
  })
})
