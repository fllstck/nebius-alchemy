/**
 * Nebius hosted-runtime support for `Nebius.compute.v1.Instance` — the
 * Effectful-Constructor half (mirrors `AWS/EC2/hosted.ts`, adapted to Nebius).
 *
 * When `main` is set, the instance bundles the user's Effect program with
 * rolldown, ships it to an S3 assets bucket (content-addressed files + a
 * stable manifest written LAST as the atomic pointer), and bootstraps the VM
 * with cloud-init: install bun, write a fetch script (carrying the DEDICATED
 * read-only fetch key) + a systemd unit whose `ExecStartPre` re-fetches the
 * manifest + files unconditionally and whose `ExecStart` runs the entry with
 * `Restart=always`.
 *
 * Deploy-time only (imported by `instance.ts`, whose D8 guard + DCE keep this
 * module — and its gRPC imports — out of deployed bundles).
 */
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Schedule from 'effect/Schedule'
import type * as PlatformError from 'effect/PlatformError'
import type * as rolldown from 'rolldown'
import { createHash } from 'node:crypto'
import * as Alchemy from 'alchemy'
import * as AlchemyNamespace from 'alchemy/Namespace'
import * as Bundle from 'alchemy/Bundle'
import * as Output from 'alchemy/Output'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import { S3Client, S3Errors } from '@bradenmacdonald/s3-lite-client'

import * as Iam from '../../iam/index.ts'
import * as Storage from '../../storage/v1/index.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as StorageGrpc from '../../../api-client/storage.ts'
import * as GrpcUtils from '../../../api-client/grpc-utils.ts'
import { hostIdentity, grantBucketAccess } from '../../shared/host-identity.ts'
import { asArrayBufferBacked } from '../../shared/s3-payload.ts'
import type { ResourceBinding } from 'alchemy'
import type { Region } from '../../regions.schema.ts'

import * as InstanceSchema from './instance.schema.ts'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when host mode is requested but the composed identity is missing. */
export class HostedRuntimeError extends Schema.TaggedError<HostedRuntimeError>()('HostedRuntimeError', {
  message: Schema.String,
}) {}

/** Raised when a user-supplied assets bucket lives in a different region than the stack. */
export class BucketRegionMismatch extends Schema.TaggedError<BucketRegionMismatch>()(
  'BucketRegionMismatch',
  {
    bucketName: Schema.String,
    bucketRegion: Schema.String,
    stackRegion: Schema.String,
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DEFAULT_REGION: Region = 'eu-north1'

/** Binding contract accepted by Nebius-hosted runtimes: environment variables injected into the shipped env file. */
export interface NebiusHostedBinding {
  env?: Record<string, unknown>
}

/**
 * Composed hosted-runtime values — declared lazily by {@link transformInstanceProps}
 * and threaded to the reconcile through the internal `hosted` prop (Output
 * expressions resolve to plain values at apply time; see
 * {@link NebiusHostedComposition} for the resolved shape).
 */
export interface NebiusHostedCompositionInput {
  /** Assets bucket name (user-supplied or provider-declared). */
  bucketName: Output.Output<string> | string
  /** Assets bucket id — only set for the provider-declared (default) bucket. */
  bucketId?: Output.Output<string>
  /** Stack region (S3 endpoint/credential scope). */
  region: Region
  /** Upload S3 creds (the shared binding `hostIdentity` key). */
  hostAccessKeyId: Output.Output<string>
  hostSecretAccessKey: Output.Output<string>
  /** The host-identity group id (subject of the upload grant). */
  hostGroupId: Output.Output<string>
  /** Dedicated read-only fetch key (lives only in the VM fetch script). */
  fetchAccessKeyId: Output.Output<string>
  fetchSecretAccessKey: Output.Output<string>
  /** The dedicated fetch identity's group id (subject of the read grant). */
  fetchGroupId: Output.Output<string>
  /**
   * Whether the USER passed `isExternal: true` explicitly (a self-serving entry:
   * the bundle IS the runnable program and must not be wrapped).
   *
   * Recorded here because this hook sees the props BEFORE `Platform` adds the
   * flag on its own (it marks any resource declared without an inline impl as
   * external). The instance provider needs that distinction to reject the
   * implicit form at plan time — see `assertHostedEntryIsRunnable` in
   * `instance.ts`.
   */
  externalOptIn?: boolean
}

/** The resolved shape of {@link NebiusHostedCompositionInput} at reconcile time. */
export interface NebiusHostedComposition {
  bucketName: string
  bucketId?: string
  region: Region
  hostAccessKeyId: string
  hostSecretAccessKey: string
  hostGroupId: string
  fetchAccessKeyId: string
  fetchSecretAccessKey: string
  fetchGroupId: string
}

/**
 * Hosted-runtime state persisted through the provider's attrs (`output`).
 * The first four mirror the public `InstanceAttributes` hosted fields; the
 * `hosted*` fields are internal state the delete lifecycle needs (S3 object
 * cleanup must authenticate with the upload creds AFTER the identity's own
 * lifecycles may have run).
 */
export interface NebiusHostedRuntimeState {
  userData?: string
  runtimeUnitName?: string
  assetPrefix?: string
  code?: { hash: string }
  hostedBucketName?: string
  hostedRegion?: string
  hostedAccessKeyId?: string
  hostedSecretAccessKey?: string
}

/** The stable, atomic manifest object at `<assetPrefix>/manifest.json`. */
export interface HostedManifest {
  schema: 1
  entry: { path: string; key: string; hash: string }
  chunks: Array<{ path: string; key: string; hash: string }>
  env: { key: string; hash: string }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Erase the deploy-time Provider requirements of lazily-declared resources.
 * The Provider requirements are REAL at deploy time but are satisfied by the
 * stack's provider collection (`Nebius.providers()`); this cast only opts out
 * of the type-level check. Encapsulated `any` — approved exception (same
 * spirit as `unrequiring` in `shared/host-identity.ts`).
 */
// oxlint-disable-next-line no-explicit-any
const unrequiring = <A>(effect: Effect.Effect<A, never, any>): Effect.Effect<A, never, never> =>
  effect as Effect.Effect<A, never, never>

const toBytes = (content: string | Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> =>
  typeof content === 'string' ? new TextEncoder().encode(content) : asArrayBufferBacked(content)

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

const messageOf = (error: unknown): string => {
  // Walk the cause chain (Effect.tryPromise wraps the real rejection in a
  // generic UnknownException whose cause holds the actual S3 error).
  const parts: string[] = []
  let current: unknown = error
  for (let i = 0; i < 5 && current !== undefined && current !== null; i++) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = (current as { cause?: unknown }).cause
    } else if (typeof current === 'object') {
      parts.push(JSON.stringify(current))
      break
    } else if (
      typeof current === 'string' ||
      typeof current === 'number' ||
      typeof current === 'boolean' ||
      typeof current === 'bigint' ||
      typeof current === 'symbol'
    ) {
      parts.push(String(current))
      break
    } else {
      break
    }
  }
  return (
    parts.filter((part) => part.length > 0 && part !== 'An error occurred in Effect.tryPromise').join(' → ') ||
    (typeof error === 'object' && error !== null ? JSON.stringify(error) : String(error))
  )
}

/**
 * Transient S3 failures worth retrying: IAM grants are eventually-consistent
 * on Nebius (AccessDenied on a just-granted key is common in the same deploy),
 * plus 5xx and network errors. 4xx (except 403) are permanent.
 */
const isTransientS3Error = (error: unknown): boolean => {
  if (error instanceof S3Errors.ServerError) {
    return error.statusCode === 403 || error.statusCode >= 500
  }
  return true
}

/** Deterministic AccessKey logical-id → physical-name derivation (mirrors the AccessKey provider). */
const hostedRuntimeKeyLogicalId = (id: string) => `${id}HostedRuntimeKey`
const hostedRuntimeKeyName = (id: string) =>
  `ak-${hostedRuntimeKeyLogicalId(id).replace(/_/g, '-').toLowerCase().slice(0, 55)}`

const createRuntimeUnitName = (id: string) =>
  AlchemyPhysicalName.createPhysicalName({
    id: `${id}-runtime`,
    maxLength: 64,
    lowercase: true,
  })

const makeS3Client = (
  region: Region,
  bucketName: string,
  accessKeyId: string,
  secretAccessKey: string,
): S3Client =>
  new S3Client({
    endPoint: `https://storage.${region}.nebius.cloud`,
    region,
    accessKey: accessKeyId,
    secretKey: secretAccessKey,
    bucket: bucketName,
    pathStyle: true,
  })

// ---------------------------------------------------------------------------
// transformProps — plan-time composition of the hosted identity
// ---------------------------------------------------------------------------

/**
 * `Platform.transformProps` hook: composes the hosted identity as REAL child
 * resources when `main` is set (no-op for low-level instances and inside
 * deployed bundles). Returns the props with the internal `hosted` field
 * carrying the composed Outputs (resolved by the engine at apply time).
 *
 * Composed per host:
 * - assets bucket — provider-declared per-stack bucket (DEFAULT), or the
 *   user-supplied bucket name (no declaration; grants become prefix-scoped
 *   bucket-policy rules at reconcile — see {@link ensureUserBucketGrants}).
 * - `hostIdentity(id)` — the shared binding identity; grants it `storage.editor`
 *   on the DEFAULT bucket (upload creds).
 * - a DEDICATED read-only fetch identity (SA + group + membership + AccessKey)
 *   granted `storage.viewer` on the DEFAULT bucket — its secret lives only in
 *   the VM fetch script and is deleted in {@link cleanupHostedRuntime}.
 */
export const transformInstanceProps = Effect.fn('transformInstanceProps')(function* (
  id: string,
  props: Record<string, unknown> | undefined,
): Effect.fn.Return<Record<string, unknown> | undefined, Config.ConfigError, Alchemy.Stack> {
  // Composition is a plan/deploy concern — never runs inside bundles.
  if (globalThis.__ALCHEMY_RUNTIME__) return props
  const news = props as InstanceSchema.InstanceProps | undefined
  if (!news?.main) return props

  // Scope the composed children under the instance's logical id (the ECS
  // `transformProps` pattern) so their FQNs can't collide with user
  // resources, and so removing the instance orphans them as a group.
  return yield* AlchemyNamespace.push(
    id,
    Effect.gen(function* () {
      const stack = yield* Alchemy.Stack
      const region = (yield* Config.String('NEBIUS_REGION').pipe(Config.withDefault(DEFAULT_REGION))) as Region

      // 1. Assets bucket — provider-declared per-stack bucket unless the user
      //    supplied one (the "one bucket for all assets" escape hatch).
      //    Keyed on the stack name so every hosted instance in the stack
      //    shares ONE bucket (idempotent duplicate-FQN registration).
      const userBucketName = news.bucket
      const defaultBucket =
        userBucketName === undefined
          ? yield* unrequiring(Storage.Bucket(`HostedAssets-${stack.name}`, {}))
          : undefined
      const bucketId = defaultBucket?.id
      const bucketName = userBucketName ?? defaultBucket!.name

      // 2. Shared binding identity — upload creds (+ editor grant on the DEFAULT bucket).
      const identity = yield* hostIdentity(id)
      if (bucketId) {
        yield* grantBucketAccess(`${id}HostedUploadAccess`, identity, bucketId, 'storage.editor')
      }

      // 3. Dedicated read-only fetch identity (+ viewer grant on the DEFAULT bucket).
      const fetchSa = yield* unrequiring(
        Iam.ServiceAccount(`${id}HostedRuntimeSA`, {
          description: 'Alchemy hosted-runtime bundle fetch identity (read-only)',
        }),
      )
      const fetchGroup = yield* unrequiring(Iam.Group(`${id}HostedRuntimeGroup`))
      yield* unrequiring(
        Iam.GroupMembership(`${id}HostedRuntimeMembership`, {
          parentId: fetchGroup.id,
          memberId: fetchSa.id,
        }),
      )
      const fetchKey = yield* unrequiring(
        Iam.AccessKey(hostedRuntimeKeyLogicalId(id), {
          serviceAccountId: fetchSa.id,
          secretDeliveryMode: 'INLINE',
        }),
      )
      if (bucketId) {
        yield* unrequiring(
          Iam.AccessPermit(`${id}HostedFetchAccess`, {
            parentId: fetchGroup.id,
            resourceId: bucketId,
            role: 'storage.viewer',
          }),
        )
      }

      return {
        ...props,
        hosted: {
          bucketName,
          bucketId,
          region,
          hostAccessKeyId: identity.awsAccessKeyId,
          hostSecretAccessKey: identity.secretAccessKey,
          hostGroupId: identity.groupId,
          fetchAccessKeyId: fetchKey.awsAccessKeyId,
          fetchSecretAccessKey: fetchKey.secretAccessKey,
          fetchGroupId: fetchGroup.id,
          // `isExternal` is undefined here when `Platform` is about to add it
          // itself (no inline impl) — see the interface doc.
          externalOptIn: news.isExternal === true,
        } satisfies NebiusHostedCompositionInput,
      }
    }),
  )
})

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

/**
 * Bundle the user's `main` entrypoint with rolldown (via `alchemy/Bundle`),
 * wrapping it in the Nebius bootstrap virtual entry when not `isExternal`.
 * Returns the bundle files (entry first) + the overall content hash.
 */
export const bundleProgram = Effect.fn('bundleProgram')(function* (
  id: string,
  props: InstanceSchema.InstanceProps,
): Effect.fn.Return<
  { files: Bundle.BundleFile[]; hash: string },
  Bundle.BundleError | HostedRuntimeError | PlatformError.PlatformError,
  import('effect/FileSystem').FileSystem | import('effect/Path').Path
> {
  if (!props.main) {
    return yield* new HostedRuntimeError({
      message: `Nebius.compute.v1.Instance '${id}' requires 'main' in host mode`,
    })
  }

  const handler = props.handler ?? 'default'
  const realMain = yield* Bundle.resolveMainPath(props.main)
  const cwd = yield* Bundle.findCwdForBundle(realMain)
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin
  // The schema validates `build` as an opaque record — the rolldown option
  // surface isn't mirrored in Schema. Cast once here; typed access below.
  const buildConfig = props.build as Bundle.BundleConfig | undefined

  const buildBundle = Effect.fn('buildBundle')(function* (
    entry: string,
    plugins?: rolldown.RolldownPluginOption,
  ): Effect.fn.Return<Bundle.BundleOutput, Bundle.BundleError> {
    return yield* Bundle.build(
      {
        ...buildConfig?.input,
        input: entry,
        cwd,
        platform: 'node',
        // The hosted process runs under `bun` (installed by cloud-init); keep
        // `bun`/`bun:*` external and resolve the `bun` export condition so
        // `@effect/platform-bun` picks its Bun implementations.
        external: ['bun', 'bun:*', ...((buildConfig?.input?.external as string[] | undefined) ?? [])],
        resolve: {
          conditionNames: ['bun', 'import', 'module', 'default'],
          ...buildConfig?.input?.resolve,
        },
        plugins: [buildConfig?.input?.plugins, plugins],
      },
      {
        ...buildConfig?.output,
        format: 'esm',
        sourcemap: buildConfig?.output?.sourcemap ?? false,
        minify: buildConfig?.output?.minify ?? false,
        entryFileNames: 'index.mjs',
      },
      buildConfig,
    )
  })

  const bundleOutput = props.isExternal
    ? yield* buildBundle(realMain)
    : yield* buildBundle(realMain, virtualEntryPlugin((importPath: string) => renderBootstrap(handler, importPath)))

  return { files: bundleOutput.files, hash: bundleOutput.hash }
})

/**
 * The generated entrypoint: imports the user's `handler` export from `main`
 * and runs the platform's collected `exports.program` (host.run / serve
 * runners) under the Bun runtime — alchemy-generic, no AWS imports (mirrors
 * the AWS EC2 bootstrap minus Credentials/Region; Nebius config flows through
 * the shipped env + `reifyBoundConfigProvider`).
 */
const renderBootstrap = (handler: string, importPath: string) => `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import { provideProcessTelemetry } from "alchemy/Telemetry";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { ${handler} as handler } from ${JSON.stringify(importPath)};

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is actually served and host.run loops stay alive.
const program = handler.pipe(
  // Process-lifetime telemetry: built once into the root scope; exporters
  // batch on their intervals and flush when the scope closes on graceful
  // shutdown.
  Effect.flatMap((instance) =>
    instance.RuntimeContext.exports.pipe(
      Effect.flatMap((exports) => exports.program),
      provideProcessTelemetry(instance.RuntimeContext),
    ),
  ),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.String("ALCHEMY_STACK_NAME"),
        Config.String("ALCHEMY_STAGE"),
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {},
        })),
      ),
    ).pipe(
      Layer.provideMerge(Layer.succeed(Stage, process.env.ALCHEMY_STAGE ?? "")),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
        ),
      ),
    ),
  ),
  Effect.scoped,
);

console.log("Nebius instance bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Nebius instance bootstrap failed:", err);
  process.exit(1);
});
`

// ---------------------------------------------------------------------------
// Env file
// ---------------------------------------------------------------------------

/**
 * Unwrap a Redacted value in the three forms the env pipeline produces:
 *
 * - a live `Redacted`;
 * - a plain `{ _tag: 'Redacted', value }` object (class identity lost), or
 * - the JSON **string** of that envelope — what survives alchemy's state
 *   store, which is the form that actually reached the VM.
 *
 * `Platform`'s plan-phase config interceptor captures every `Config.*` lookup as
 * `Output.literal(Redacted.make(value))` and folds it into the resource's `env`,
 * so a config value (e.g. the region read by `transformInstanceProps`) can
 * override the binding-supplied plain value. The env file is PLAINTEXT on the
 * VM, so without this the VM received the envelope instead of the value —
 * `NEBIUS_REGION={"_tag":"Redacted","value":"eu-north1"}` — which made the
 * hosted instance sign S3 requests with a garbage region ("The authorization
 * header that you provided is not valid."; found by the hosted-instance e2e on
 * real infra, 2026-09-10).
 */
export const unwrapRedacted = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value)
  if (typeof value === 'string') return parseRedactedEnvelope(value) ?? value
  if (typeof value !== 'object' || value === null) return value
  const serialized = value as { _tag?: unknown; value?: unknown }
  return serialized._tag === 'Redacted' ? serialized.value : value
}

/** `{"_tag":"Redacted","value":"…"}` as a string → the value (undefined when it is not that envelope). */
const parseRedactedEnvelope = (value: string): string | undefined => {
  if (!value.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const envelope = parsed as { _tag?: unknown; value?: unknown }
    return envelope._tag === 'Redacted' && typeof envelope.value === 'string' ? envelope.value : undefined
  } catch {
    return undefined
  }
}

/** Systemd EnvironmentFile escaping (copied from the AWS EC2 hosted runtime). */
export const quoteEnvValue = (value: unknown): string => {
  const unwrapped = unwrapRedacted(value)
  const text = typeof unwrapped === 'string' ? unwrapped : JSON.stringify(unwrapped ?? null)
  return `'${text.replaceAll(/'/g, `'""'`).replaceAll(/\n/g, '\\n')}'`
}

/** Sorted `KEY=value` lines with quoted values. */
export const renderEnvFile = (env: Record<string, unknown>): string =>
  Object.entries(env)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join('\n')

// ---------------------------------------------------------------------------
// Cloud-init user-data
// ---------------------------------------------------------------------------

/** Prepend `spaces` spaces to every line (YAML literal-block indentation). */
const indent = (text: string, spaces: number): string =>
  text
    .split('\n')
    .map((line) => `${' '.repeat(spaces)}${line}`)
    .join('\n')

/**
 * The fetch script (written to disk by cloud-init): reads the stable manifest
 * (the atomic pointer) then pulls every content-addressed file + env. Runs on
 * EVERY service start via `ExecStartPre`, so a restart always converges to the
 * latest bundle. The dedicated read-only access key is embedded here — and
 * nowhere else.
 */
const renderFetchScript = ({
  appDir,
  bucketName,
  region,
  manifestKey,
  fetchAccessKeyId,
  fetchSecretAccessKey,
}: {
  appDir: string
  bucketName: string
  region: Region
  manifestKey: string
  fetchAccessKeyId: string
  fetchSecretAccessKey: string
}): string => `#!/usr/bin/env bash
set -uo pipefail
export HOME=/root

APP_DIR="${appDir}"
BUCKET="${bucketName}"
REGION="${region}"
ENDPOINT="https://storage.${region}.nebius.cloud"
MANIFEST_KEY="${manifestKey}"
AWS_ACCESS_KEY_ID="${fetchAccessKeyId}"
AWS_SECRET_ACCESS_KEY="${fetchSecretAccessKey}"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

set -e
mkdir -p "\${APP_DIR}"

python3 - "\${APP_DIR}" "\${BUCKET}" "\${REGION}" "\${ENDPOINT}" "\${MANIFEST_KEY}" <<'PYEOF'
import datetime
import hashlib
import hmac
import json
import os
import sys
import urllib.request
from urllib.parse import quote

app_dir, bucket, region, endpoint, manifest_key = sys.argv[1:]
access_key = os.environ["AWS_ACCESS_KEY_ID"]
secret_key = os.environ["AWS_SECRET_ACCESS_KEY"]


def sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def get_object(key):
    host = endpoint.replace("https://", "").replace("http://", "").split("/")[0]
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()
    path = "/" + quote(bucket, safe="") + "/" + quote(key, safe="/")
    canonical_headers = "host:{}\\nx-amz-content-sha256:{}\\nx-amz-date:{}\\n".format(
        host, payload_hash, amz_date
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\\n".join(
        ["GET", path, "", canonical_headers, signed_headers, payload_hash]
    )
    scope = "{}/{}/s3/aws4_request".format(date_stamp, region)
    string_to_sign = "\\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    k = sign(("AWS4" + secret_key).encode("utf-8"), date_stamp)
    k = sign(k, region)
    k = sign(k, "s3")
    k = sign(k, "aws4_request")
    signature = hmac.new(k, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    url = "{}/{}/{}".format(endpoint, quote(bucket, safe=""), quote(key, safe="/"))
    req = urllib.request.Request(url, method="GET")
    req.add_header("x-amz-date", amz_date)
    req.add_header("x-amz-content-sha256", payload_hash)
    req.add_header(
        "Authorization",
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}".format(
            access_key, scope, signed_headers, signature
        ),
    )
    with urllib.request.urlopen(req) as resp:
        return resp.read()


manifest = json.loads(get_object(manifest_key))
for entry in [manifest["entry"]] + manifest.get("chunks", []):
    data = get_object(entry["key"])
    dest = os.path.join(app_dir, entry["path"])
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)
env_data = get_object(manifest["env"]["key"])
with open(os.path.join(app_dir, "env"), "wb") as f:
    f.write(env_data)
print("fetched bundle", manifest_key)
PYEOF
`

/** The systemd unit for the hosted runtime service. */
const renderUnitFile = ({ unitName, appDir }: { unitName: string; appDir: string }): string => `[Unit]
Description=Alchemy Nebius instance runtime ${unitName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${appDir}
ExecStartPre=/usr/local/bin/${unitName}-fetch.sh
EnvironmentFile=-${appDir}/env
# --no-install: the uploaded bundle is self-contained; bun must never fall
# into its auto-install path (which hangs startup on network package
# resolution) — fail fast if the bundle is incomplete instead.
ExecStart=/root/.bun/bin/bun --no-install ${appDir}/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`

/**
 * Cloud-init user-data for the hosted instance (target image:
 * `ubuntu24.04-driverless` default) in **`#cloud-config`** format (empirically
 * verified to run on the Nebius cloud images — plain shell-script user-data
 * does not reliably execute there).
 *
 * First-boot only: writes the fetch script + systemd unit (`write_files`),
 * installs bun (skip if present; needs outbound HTTPS), and enables + starts
 * the unit (`runcmd`). The unit's `ExecStartPre` re-fetches the manifest +
 * files UNCONDITIONALLY on every start, so code updates (stop→start or a
 * crash restart) converge to the latest manifest without any user-data change.
 */
export const renderHostedUserData = ({
  unitName,
  bucketName,
  region,
  manifestKey,
  fetchAccessKeyId,
  fetchSecretAccessKey,
}: {
  unitName: string
  bucketName: string
  region: Region
  manifestKey: string
  fetchAccessKeyId: string
  fetchSecretAccessKey: string
}): string => {
  const appDir = `/opt/${unitName}`
  const fetchScript = renderFetchScript({ appDir, bucketName, region, manifestKey, fetchAccessKeyId, fetchSecretAccessKey })
  const unitFile = renderUnitFile({ unitName, appDir })
  return `#cloud-config
write_files:
  - path: /usr/local/bin/${unitName}-fetch.sh
    permissions: '0755'
    content: |
${indent(fetchScript, 6)}
  - path: /etc/systemd/system/${unitName}.service
    content: |
${indent(unitFile, 6)}
runcmd:
  - mkdir -p ${appDir}
  - [bash, -c, 'export HOME=/root; command -v unzip >/dev/null 2>&1 || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y unzip) || true; if [ ! -x /root/.bun/bin/bun ]; then for attempt in 1 2 3 4 5; do curl -fsSL https://bun.sh/install | bash && break; sleep 5; done; fi']
  - systemctl daemon-reload
  - systemctl enable --now ${unitName}.service
`
}

/**
 * Merge the user's cloud-init data into the generated bootstrap using
 * cloud-init's MIME multipart convention (each part processed by its own
 * handler): the generated `#cloud-config` bootstrap first, the user's data
 * after. The user part is `text/cloud-config` when it declares itself, else
 * `text/x-shellscript`.
 */
export const mergeUserData = (hosted: string, userData?: string): string => {
  if (!userData) return hosted
  const boundary = '//alchemy-nebius//'
  const userContentType = userData.startsWith('#cloud-config')
    ? 'text/cloud-config'
    : 'text/x-shellscript'
  return [
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    'MIME-Version: 1.0',
    '',
    '--' + boundary,
    'Content-Type: text/cloud-config; charset="us-ascii"',
    '',
    hosted,
    '--' + boundary,
    `Content-Type: ${userContentType}; charset="us-ascii"`,
    '',
    userData,
    '--' + boundary + '--',
    '',
  ].join('\n')
}
// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/** One planned S3 write — files + env first, the MANIFEST (atomic pointer) LAST. */
export interface HostedUploadWrite {
  key: string
  content: string | Uint8Array<ArrayBufferLike>
  /** The atomic pointer object — always the final write of a plan. */
  manifest: boolean
}

/** The ordered S3 write plan for a hosted bundle — pure, unit-testable. */
export interface HostedUploadPlan {
  writes: Array<HostedUploadWrite>
  manifest: HostedManifest | undefined
  envKey: string
}

/**
 * Plan the upload: content-addressed bundle files + env, then the manifest at
 * its STABLE key (`<assetPrefix>/manifest.json`) as the LAST write. The VM
 * reads the manifest first, so a torn upload is invisible until the manifest
 * lands — the manifest is the atomic pointer the VM converges to.
 */
export const planHostedUploads = ({
  assetPrefix,
  files,
  env,
}: {
  assetPrefix: string
  files: Array<Bundle.BundleFile>
  env: Record<string, unknown>
}): HostedUploadPlan => {
  const writes: Array<HostedUploadWrite> = []

  // 1. Content-addressed files — immutable object keys (hash in the key).
  const uploaded: Array<{ path: string; key: string; hash: string }> = []
  for (const file of files) {
    const key = `${assetPrefix}/files/${file.hash}/${file.path}`
    writes.push({ key, content: file.content, manifest: false })
    uploaded.push({ path: file.path, key, hash: file.hash })
  }

  // 2. Env file — content-addressed too (a stable env key would let a VM
  //    fetching the OLD manifest observe the NEW env mid-deploy).
  const envText = renderEnvFile(env)
  const envKey = `${assetPrefix}/env/${sha256Hex(envText)}`
  writes.push({ key: envKey, content: envText, manifest: false })

  // 3. Manifest LAST — the atomic pointer (entry + chunks + env).
  const [entry, ...chunks] = uploaded
  if (!entry) {
    return { writes, manifest: undefined, envKey }
  }
  const manifest: HostedManifest = {
    schema: 1,
    entry,
    chunks,
    env: { key: envKey, hash: sha256Hex(envText) },
  }
  writes.push({
    key: `${assetPrefix}/manifest.json`,
    content: JSON.stringify(manifest, null, 2),
    manifest: true,
  })
  return { writes, manifest, envKey }
}

/**
 * Upload the planned writes (files + env, then the manifest LAST — the
 * atomic pointer the VM converges to).
 */
export const uploadHostedArtifacts = Effect.fn('uploadHostedArtifacts')(function* ({
  assetPrefix,
  bucketName,
  region,
  accessKeyId,
  secretAccessKey,
  files,
  env,
}: {
  assetPrefix: string
  bucketName: string
  region: Region
  accessKeyId: string
  secretAccessKey: string
  files: Array<Bundle.BundleFile>
  env: Record<string, unknown>
}): Effect.fn.Return<{ manifestKey: string; manifest: HostedManifest }, HostedRuntimeError> {
  const client = makeS3Client(region, bucketName, accessKeyId, secretAccessKey)
  const plan = planHostedUploads({ assetPrefix, files, env })
  if (!plan.manifest) {
    return yield* new HostedRuntimeError({ message: 'Hosted bundle produced no entry file' })
  }

  const put = (key: string, data: string | Uint8Array<ArrayBufferLike>) =>
    Effect.tryPromise(() => client.putObject(key, toBytes(data), { bucketName })).pipe(
      // The upload grant (AccessPermit) is eventually-consistent — retry
      // transient 403/5xx/network failures with a bounded backoff.
      Effect.retry({
        times: 5,
        schedule: Schedule.exponential('1 second', 2),
        while: isTransientS3Error,
      }),
      Effect.mapError((error: unknown) =>
        new HostedRuntimeError({
          message: `S3 upload of "${key}" to bucket "${bucketName}" failed: ${messageOf(error)}`,
        }),
      ),
    )

  for (const write of plan.writes) {
    yield* put(write.key, write.content)
  }

  return { manifestKey: `${assetPrefix}/manifest.json`, manifest: plan.manifest }
})

// ---------------------------------------------------------------------------
// User-supplied bucket: region check + prefix-scoped policy rules
// ---------------------------------------------------------------------------

/**
 * For USER-SUPPLIED buckets only: verify the bucket lives in the stack's
 * region (region-scoped S3 keys) and grant prefix-scoped access via
 * bucket-policy rules (read-modify-write preserving the user's existing
 * rules, with resourceVersion-conflict retry). The DEFAULT provider-declared
 * bucket uses IAM AccessPermits instead (declared in {@link transformInstanceProps}).
 */
export const ensureUserBucketGrants = Effect.fn('ensureUserBucketGrants')(function* ({
  bucketName,
  region,
  assetPrefix,
  fetchGroupId,
  hostGroupId,
}: {
  bucketName: string
  region: Region
  assetPrefix: string
  fetchGroupId: string
  hostGroupId: string
}): Effect.fn.Return<
  void,
  | BucketRegionMismatch
  | Config.ConfigError
  | GrpcUtils.GrpcError
  | GrpcUtils.GrpcDeadlineExceededError
  | GrpcUtils.OperationFailedError,
  StorageGrpc.StorageGrpcService
> {
  const storageGrpcService = yield* StorageGrpc.StorageGrpcService
  const parentId = yield* Config.String('NEBIUS_PROJECT_ID')

  // Read the bucket (re-read on resourceVersion-conflict retry).
  const readBucket = () => storageGrpcService.bucket.getByName(parentId, bucketName)

  const bucket = yield* readBucket()
  const bucketRegion = bucket.status?.region
  if (bucketRegion !== undefined && bucketRegion !== region) {
    return yield* new BucketRegionMismatch({
      bucketName,
      bucketRegion,
      stackRegion: region,
      message: `Assets bucket "${bucketName}" is in region "${bucketRegion}" but the instance stack is in "${region}". S3 access keys are region-scoped — use a bucket in the same region.`,
    })
  }

  const desiredRules = [
    { paths: [`${assetPrefix}/*`], roles: ['storage.viewer'], groupId: fetchGroupId },
    { paths: [`${assetPrefix}/*`], roles: ['storage.editor'], groupId: hostGroupId },
  ]

  const applyRules = Effect.gen(function* (): Effect.fn.Return<
    void,
    GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError | GrpcUtils.OperationFailedError,
    StorageGrpc.StorageGrpcService
  > {
    const current = yield* readBucket()
    const existingRules = [...(current.spec?.bucketPolicy?.rules ?? [])]
    const rules = [...existingRules]
    for (const rule of desiredRules) {
      const alreadyGranted = existingRules.some(
        (existing) =>
          existing.groupId === rule.groupId &&
          (existing.roles ?? []).includes(rule.roles[0]!) &&
          (existing.paths ?? []).includes(rule.paths[0]!),
      )
      if (!alreadyGranted) rules.push(rule)
    }
    yield* storageGrpcService.bucket.update({
      metadata: {
        id: current.metadata!.id,
        parentId,
        resourceVersion: current.metadata!.resourceVersion.toString(),
      },
      spec: {
        ...current.spec,
        bucketPolicy: { rules },
      },
    })
  })

  // resourceVersion conflicts (GrpcError 6 ABORTED / 9 FAILED_PRECONDITION)
  // mean a concurrent deploy touched the bucket — re-read and retry.
  yield* applyRules.pipe(
    Effect.retry({
      times: 4,
      schedule: Schedule.spaced('1 second'),
      while: (e: unknown) => e instanceof GrpcUtils.GrpcError && (e.code === 6 || e.code === 9),
    }),
  )
})

// ---------------------------------------------------------------------------
// Resolve / cleanup
// ---------------------------------------------------------------------------

/**
 * Idempotent observe→ensure flow for host mode, driven by persisted `output`.
 * Bundles the program, uploads the artifacts (manifest last), renders the
 * cloud-init user-data (merged with the user's), and returns the runtime
 * state to persist. Also verifies + grants user-supplied buckets.
 */
export const resolveHostedRuntime = Effect.fn('resolveHostedRuntime')(function* ({
  id,
  news,
  bindings,
  output,
}: {
  id: string
  news: InstanceSchema.InstanceProps
  bindings: Array<ResourceBinding<NebiusHostedBinding> & { action?: string }>
  output?: NebiusHostedRuntimeState
}): Effect.fn.Return<
  NebiusHostedRuntimeState,
  | HostedRuntimeError
  | BucketRegionMismatch
  | Bundle.BundleError
  | PlatformError.PlatformError
  | Config.ConfigError
  | GrpcUtils.GrpcError
  | GrpcUtils.GrpcDeadlineExceededError
  | GrpcUtils.OperationFailedError,
  | Alchemy.Stack
  | Alchemy.Stage
  | Alchemy.InstanceId
  | StorageGrpc.StorageGrpcService
  | import('effect/FileSystem').FileSystem
  | import('effect/Path').Path
> {
  // Low-level mode — no hosted runtime; pass through untouched.
  if (!news.main) {
    return {
      userData: news.cloudInitUserData,
      runtimeUnitName: output?.runtimeUnitName,
      assetPrefix: output?.assetPrefix,
      code: output?.code,
      hostedBucketName: output?.hostedBucketName,
      hostedRegion: output?.hostedRegion,
      hostedAccessKeyId: output?.hostedAccessKeyId,
      hostedSecretAccessKey: output?.hostedSecretAccessKey,
    }
  }

  const composed = news.hosted as NebiusHostedComposition | undefined
  if (!composed) {
    return yield* new HostedRuntimeError({
      message: `Nebius.compute.v1.Instance '${id}': host mode requires the composed hosted identity — set 'main' (transformProps did not run)`,
    })
  }

  const stack = yield* Alchemy.Stack
  const stage = yield* Alchemy.Stage

  const runtimeUnitName = output?.runtimeUnitName ?? (yield* createRuntimeUnitName(id))
  const assetPrefix = output?.assetPrefix ?? `compute/${runtimeUnitName}`

  // User-supplied buckets: region check + prefix-scoped policy rules.
  if (news.bucket !== undefined) {
    yield* ensureUserBucketGrants({
      bucketName: composed.bucketName,
      region: composed.region,
      assetPrefix,
      fetchGroupId: composed.fetchGroupId,
      hostGroupId: composed.hostGroupId,
    })
  }

  // Bundle → upload (manifest written last) → user-data.
  const { files, hash } = yield* bundleProgram(id, news)
  const { manifestKey } = yield* uploadHostedArtifacts({
    assetPrefix,
    bucketName: composed.bucketName,
    region: composed.region,
    accessKeyId: composed.hostAccessKeyId,
    secretAccessKey: composed.hostSecretAccessKey,
    files,
    env: hostedEnv({
      stackName: stack.name,
      stage,
      port: news.port,
      userEnv: news.env,
      bindings,
    }),
  })

  const hostedUserData = renderHostedUserData({
    unitName: runtimeUnitName,
    bucketName: composed.bucketName,
    region: composed.region,
    manifestKey,
    fetchAccessKeyId: composed.fetchAccessKeyId,
    fetchSecretAccessKey: composed.fetchSecretAccessKey,
  })

  return {
    userData: mergeUserData(hostedUserData, news.cloudInitUserData),
    runtimeUnitName,
    assetPrefix,
    code: { hash },
    hostedBucketName: composed.bucketName,
    hostedRegion: composed.region,
    hostedAccessKeyId: composed.hostAccessKeyId,
    hostedSecretAccessKey: composed.hostSecretAccessKey,
  }
})

/**
 * The shipped env file: bindings → alchemy runtime env → PORT → user env (user wins).
 *
 * Exported for the seam test: this is where a binding's `data.env` (registered
 * by `bindInstanceHostEnv` during construction) becomes the systemd
 * `EnvironmentFile` the instance's program reads via `process.env`.
 */
const unwrapEnvValue = unwrapRedacted

export const hostedEnv = ({
  stackName,
  stage,
  port,
  userEnv,
  bindings,
}: {
  stackName: string
  stage: string
  port: number | undefined
  userEnv: Record<string, string> | undefined
  bindings: Array<ResourceBinding<NebiusHostedBinding> & { action?: string }>
}): Record<string, unknown> => {
  const bindingEnv: Record<string, unknown> = {}
  for (const binding of bindings) {
    if (binding.action === 'delete') continue
    Object.assign(bindingEnv, binding.data?.env)
  }

  return {
    ...Object.fromEntries(Object.entries(bindingEnv).map(([key, value]) => [key, unwrapEnvValue(value)])),
    ALCHEMY_STACK_NAME: stackName,
    ALCHEMY_STAGE: stage,
    ALCHEMY_PHASE: 'runtime',
    PORT: port ?? 3000,
    ...userEnv,
  }
}

/**
 * Delete the hosted S3 objects (under `assetPrefix`) and the DEDICATED
 * hosted-runtime fetch key. Idempotent — anything already gone is success.
 * Uses the persisted upload creds (the fetch key is read-only by design and
 * can't delete objects).
 */
export const cleanupHostedRuntime = Effect.fn('cleanupHostedRuntime')(function* ({
  id,
  output,
  session,
}: {
  id: string
  output?: NebiusHostedRuntimeState
  session?: { note(message: string): Effect.Effect<void> }
}): Effect.fn.Return<void, Config.ConfigError, IamGrpc.IamGrpcService> {
  // 1. S3 objects under the asset prefix (best-effort — NOT_FOUND = success).
  if (
    output?.assetPrefix &&
    output.hostedBucketName &&
    output.hostedRegion &&
    output.hostedAccessKeyId &&
    output.hostedSecretAccessKey
  ) {
    const client = makeS3Client(
      output.hostedRegion as Region,
      output.hostedBucketName,
      output.hostedAccessKeyId,
      output.hostedSecretAccessKey,
    )
    yield* Effect.tryPromise(async () => {
      // Collect the object keys under the prefix first — the generator can't
      // be driven from an Effect context.
      const keys: Array<string> = []
      for await (const obj of client.listObjects({
        prefix: `${output.assetPrefix}/`,
        bucketName: output.hostedBucketName,
      })) {
        keys.push(obj.key)
      }
      return keys
    }).pipe(
      Effect.flatMap((keys) =>
        Effect.forEach(
          keys,
          (key) =>
            Effect.tryPromise(() => client.deleteObject(key, { bucketName: output.hostedBucketName })).pipe(
              // Bounded retry on transient 403/5xx/network — the grant may
              // still be propagating; a silent leak (BucketNotEmpty) is worse
              // than a wait.
              Effect.retry({
                times: 4,
                schedule: Schedule.spaced('2 seconds'),
                while: isTransientS3Error,
              }),
            ),
          { concurrency: 'unbounded' },
        ),
      ),
      // Log failures loudly — a silent leak (BucketNotEmpty on the bucket
      // delete) is worse than a noisy destroy.
      Effect.tapError((error: unknown) =>
        Effect.logWarning(
          `Hosted assets S3 cleanup failed for ${output.hostedBucketName} (${output.assetPrefix}): ${messageOf(error)}`,
        ),
      ),
      Effect.ignore,
    )
  } else {
    yield* Effect.logWarning(
      `Skipping hosted assets S3 cleanup — missing persisted state (bucket=${output?.hostedBucketName}, prefix=${output?.assetPrefix}, keyId=${output?.hostedAccessKeyId ? 'set' : 'missing'}, secret=${output?.hostedSecretAccessKey ? 'set' : 'missing'})`,
    )
  }

  // 2. Dedicated fetch key — deterministic name lookup, already-gone = success.
  const iamGrpcService = yield* IamGrpc.IamGrpcService
  const parentId = yield* Config.String('NEBIUS_PROJECT_ID')
  const keys = yield* iamGrpcService.accessKeyV2.list(parentId).pipe(Effect.catch(() => Effect.succeed([])))
  const key = keys.find((candidate) => candidate.metadata?.name === hostedRuntimeKeyName(id))
  if (key?.metadata?.id) {
    yield* iamGrpcService.accessKeyV2.delete(key.metadata.id).pipe(
      Effect.catch((e: unknown) =>
        Effect.succeed(undefined).pipe(
          Effect.tap(() => Effect.logWarning(`Hosted fetch key already gone (${messageOf(e)})`)),
        ),
      ),
    )
  }

  if (session) {
    yield* session.note('Cleaned hosted assets for Nebius.compute.v1.Instance')
  }
})
