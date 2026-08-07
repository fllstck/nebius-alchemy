/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Bindings — ASYNC-worker variant (tiny bundle, alchemy-native)
 *
 * Same deploy-time wiring as `storage.bindings.ts`, but the Worker is a plain async
 * entry (`storage-async.bindings-worker.ts`): no Effect runtime in the bundle, so the
 * deployed size is a fraction of the Effect-native variant (~50-150 KB vs
 * ~2 MB).
 *
 * Wiring style: alchemy's native async pattern — declare the identity chain
 * (SA → editors-group grant → access key) as stack resources and pass their
 * OUTPUT values via the Worker's `env` prop. Alchemy resolves them at deploy
 * time and records the bindings (`Redacted` → `secret_text`). No binding
 * layers involved; the async worker reads `env` with s3-lite-client.
 *
 * The trade: the worker uses s3-lite directly from `env`, not the typed
 * `GetObject`/`PutObject` contracts.
 *
 * Usage:
 *   NEBIUS_TENANT_ID=<tenant-id> alchemy deploy --yes
 *   alchemy destroy --yes
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Output from 'alchemy/Output'
import * as Redacted from 'effect/Redacted'
import * as Nebius from '@fllstck/nebius-alchemy'
import { NebiusBucket } from '@fllstck/nebius-alchemy/resources/storage/v1/bucket.ts'
import {
  NebiusServiceAccount,
} from '@fllstck/nebius-alchemy/resources/iam/v1/service-account.ts'
import {
  NebiusGroupMembership,
} from '@fllstck/nebius-alchemy/resources/iam/v1/group-membership.ts'
import {
  NebiusAccessKey,
} from '@fllstck/nebius-alchemy/resources/iam/v2/access-key.ts'

const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m'
const REGION = process.env.NEBIUS_REGION ?? 'eu-north1'

export default Alchemy.Stack(
  'BindingsAsync',
  {
    providers: Layer.mergeAll(Cloudflare.providers()).pipe(Layer.provideMerge(Nebius.providers())),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bucket = yield* NebiusBucket('assets', {
      versioningPolicy: 'DISABLED',
      defaultStorageClass: 'STANDARD',
      objectAuditLogging: 'NONE',
      forceStorageClass: false,
    })

    // The host identity: SA → editors group (the grant) → access key. The
    // outputs feed the Worker's env prop below.
    const sa = yield* NebiusServiceAccount('ApiBindingSA', {
      description: 'async bindings host identity',
    })
    yield* NebiusGroupMembership('ApiBindingMembership', {
      parentId: EDITORS_GROUP_ID as never,
      memberId: sa.id,
    })
    const key = yield* NebiusAccessKey('ApiBindingKey', {
      serviceAccountId: sa.id,
      secretDeliveryMode: 'INLINE',
    })

    const Api = Cloudflare.Worker('Api', {
      // Resolve relative to this file (the stack lives in examples/), not the CWD.
      main: import.meta.resolve('./storage-async.bindings-worker.ts', import.meta.url),
      env: {
        NEBIUS_S3_ENDPOINT: `https://storage.${REGION}.nebius.cloud`,
        NEBIUS_REGION: REGION,
        // Output expressions — alchemy resolves them at deploy time and
        // records the bindings (Redacted → secret_text).
        NEBIUS_ACCESS_KEY_ID: key.awsAccessKeyId,
        NEBIUS_SECRET_ACCESS_KEY: Output.map(key.secretAccessKey, (s) => Redacted.make(s)),
        NEBIUS_BUCKET_NAME: bucket.name,
      },
    })
    yield* Api

    return { bucketId: bucket.id, bucketName: bucket.name }
  }),
)
