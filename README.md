# Nebius AI Cloud for Alchemy

Build Nebius cloud infrastructure as typed [Effect](https://effect.website) programs. GPU compute, VPC networks, IAM, object storage, DNS, KMS, and secrets — all in one TypeScript program, deployed with [Alchemy](https://alchemy.run).

Check the [examples](examples/README.md).

## Quick Start

You need [a Nebius account](https://nebius.com/) and [Bun](https://bun.sh/).

No external CLI required.

### Create a Project

```bash
mkdir my-app && cd my-app && bun init -y
```

### Install Dependencies

```bash
bun add alchemy@2.0.0-beta.79 effect@4.0.0-rc.115 @effect/platform-bun@4.0.0-rc.115 @effect/platform-node@4.0.0-rc.115 @fllstck/nebius-alchemy
```

> **Versions are pinned exactly, and that is deliberate.** Alchemy and Effect must
> move together — alchemy pins the Effect release it compiles against, and a
> mismatch fails at import. `alchemy@2.0.0-beta.79` requires
> `effect@4.0.0-rc.115`.
>
> **Avoid `alchemy@next`.** The `next` dist-tag currently points at an _older_
> beta (`2.0.0-beta.72`) than `latest` (`2.0.0-beta.79`).
>
> **Type checking with `tsc`?** This package ships raw TypeScript (bun-first, no build step). If you typecheck with `tsc`, enable `allowImportingTsExtensions` (requires `noEmit`), e.g. `"moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true`.

### Implement the Stack

A simple stack that creates a Nebius Bucket.

```ts
// alchemy.run.ts

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export default Alchemy.Stack(
  'Storage',
  {
    providers: Nebius.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket('MyBucket')
    return { bucketId: bucket.id, bucketName: bucket.name }
  }),
)
```

### Authenticate

```bash
bun alchemy profile edit --add Nebius
```

This opens your browser for a Nebius OAuth login, then asks you to pick a
project — no external CLI, no API key, no environment variables. The chosen
tenant and project are stored and used by every deploy.

> **Write your stack entrypoint first.** `alchemy profile edit` loads your
> `alchemy.run.ts` to discover which auth providers exist, so running it before
> that file exists fails with `Auth provider 'Nebius' is not registered.` (The
> Quick Start order above — install, implement, then authenticate — avoids this.
> If your entrypoint is not `alchemy.run.ts`, pass `--config <file>`.)

The OAuth login uses Nebius's shared `nebius-cli` client id by default — fine
for evaluation, but a third-party use of a client we don't own (no separate
trust boundary, fragile to their config changes). For a distinct trust
boundary, register your own **public** OAuth client with Nebius (loopback
redirect `http://127.0.0.1:<port>`, PKCE) and point the provider at it:

```bash
export NEBIUS_OAUTH_CLIENT_ID=<your-registered-client-id>
```

Only registered client ids work — the token endpoint rejects unknown ones
with `invalid_client` after the browser flow completes.

Alternatively, for automation/CI:

- **`env`** — a static IAM API key via `NEBIUS_API_KEY`. Works anywhere: locally
  and in CI.
- **`sa-key`** — a service-account key (RSA-4096 authorized key). Renewal is
  automatic via the RFC 8693 token exchange, so it needs no browser after the
  one-time bootstrap (choose _Service Account Key_ during `alchemy profile edit`).
  In CI, set `NEBIUS_SA_ID`, `NEBIUS_SA_KEY_ID` and `NEBIUS_SA_PRIVATE_KEY` (or
  `NEBIUS_SA_PRIVATE_KEY_FILE`).

> ⚠️ **The `NEBIUS_SA_*` key triple is read only when `CI=true`.** Outside CI those
> variables are ignored — a local run uses `NEBIUS_API_KEY` or the stored profile,
> and otherwise reports `Provider 'Nebius' is not configured in profile …`. That is
> deliberate: the variables are only meaningful together, and the CLI's
> provider-discovery step cannot tell a half-configured group from a complete one.

Deploy the bucket.

```bash
bun alchemy deploy --yes
```

Delete the bucket.

```bash
bun alchemy destroy --yes
```

### Stages

Every stack is namespaced by a **stage**, which selects the state directory
(`.alchemy/state/<Stack>/<stage>/`) and is baked into generated resource names:

| Command                               | Default stage |
| ------------------------------------- | ------------- |
| `alchemy deploy` / `destroy` / `plan` | `live_$USER`  |
| `alchemy dev`                         | `dev_$USER`   |

Override with `--stage <name>`, or set **`ALCHEMY_STAGE`** in the environment.
The older `$STAGE` variable is **no longer consulted**.

### Peer Dependencies

The package ships raw TypeScript source and requires these peer dependencies in your project.
Versions are **pinned exactly** — alchemy and Effect move together, so a mismatched pair fails
at import (see _Install Dependencies_ above):

| Package                        | Required | Pinned to                                                                                 |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| `effect`                       | Yes      | `4.0.0-rc.115`                                                                            |
| `@effect/platform-bun`         | Yes      | `4.0.0-rc.115`                                                                            |
| `@effect/platform-node`        | Yes      | `4.0.0-rc.115` — required by the Alchemy CLI                                              |
| `@effect/platform-node-shared` | Yes      | `4.0.0-rc.115` — declared exact so npm resolves the whole `@effect/*` family consistently |
| `typescript`                   | Yes      | TypeScript 7 (`^7`)                                                                       |
| `alchemy`                      | Yes      | `2.0.0-beta.79` — the `latest` tag. **Not** `@next`, which points at an _older_ beta      |

### tsconfig.json

The package uses `.ts` extensions in imports, so your `tsconfig.json` must enable bundler-style module resolution:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "target": "ESNext"
  }
}
```

### Runtime

The package uses Bun-native APIs and requires **Bun >= 1.2.0** or **Node >= 22.0.0**.

## Environment Variables

| Variable                                                                                | Required                               | Description                                                                                                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `NEBIUS_PROJECT_ID`                                                                     | with `env` / env-var `sa-key`          | Project ID — not needed after `alchemy profile edit` or the SA bootstrap (picked at login)                                    |
| `NEBIUS_TENANT_ID`                                                                      | with `env` / env-var `sa-key`          | Tenant ID for project/group discovery/creation actions                                                                        |
| `NEBIUS_API_KEY`                                                                        | with `env`                             | IAM API key for the `env` auth method. Read locally **and** in CI                                                             |
| `NEBIUS_SA_ID` / `NEBIUS_SA_KEY_ID` / `NEBIUS_SA_PRIVATE_KEY` (or `…_PRIVATE_KEY_FILE`) | with `sa-key`, **CI only** (`CI=true`) | Service-account key material for the RFC 8693 exchange. Ignored outside CI — use a stored profile or `NEBIUS_API_KEY` locally |
| `NEBIUS_REGION`                                                                         | —                                      | Default region (defaults to `eu-north1`)                                                                                      |
| `NEBIUS_OAUTH_CLIENT_ID`                                                                | OAuth login                            | Client id for the browser OAuth login (default: `nebius-cli`; set to a client registered with Nebius)                         |

## Resources

All resources that are currently implemented.

All resources use the `NEBIUS_PROJECT_ID` environment variable as default `parentId` where appropriate.

### Compute

Deploy GPU-accelerated instances, disks, and managed filesystems.

- **`Nebius.compute.Instance`** — GPU VMs with H200 support, preemptible instances, custom boot disks and network interfaces
- **`Nebius.compute.Disk`** — Network SSD and HDD disks, bootable from images or snapshots
- **`Nebius.compute.Image`** — Dynamic image lookup by family (`ubuntu-22-04-lts`, etc.)
- **`Nebius.compute.Filesystem`** — Managed NFS filesystems
- **`Nebius.compute.DiskSnapshot`** — Point-in-time disk snapshots
- **`Nebius.compute.GpuCluster`** — InfiniBand GPU clusters. The spec is a single immutable field (`infinibandFabric`), so any change replaces the cluster; `instances` is read-only (membership is declared on the Instance via `gpuCluster.id`), and deleting a cluster that still has members fails with `GpuClusterNotEmpty` naming them
- **`Nebius.compute.NVLInstanceGroup`** — NVLink instance groups (`GB200`/`GB300` racks). `type` is immutable (a change replaces); `size` is the maximum member count and adjusts in place; `instances` is read-only (membership is declared on the Instance via `nvlInstanceGroupId`), and deleting a non-empty group fails with `NVLInstanceGroupNotEmpty`

> ⚠️ **`GpuCluster` needs a fabric ID.** `infinibandFabric` is a *physical*
> InfiniBand fabric in the target region. Read the available ones with
> `Nebius.capacity.action.ListResourceAdvice({ region })` (see Discovery Actions
> below; `nebius capacity resource-advice list` shows the same data). Both new
> resources are unit-tested and plan-time validated, but **not yet exercised
> against real infra** — the read-only half of that probe ships as
> `tests/resources/actions/capacity.integration.test.ts`, and the create step is
> queued (see TASKS.md §"fabric discovery").

### AI

Run containerized AI workloads on Nebius AI Cloud. Neither resource supports
in-place updates — any spec change (or name change) replaces the resource.

- **`Nebius.ai.Job`** — Run-to-completion container workloads (one run per resource; replace to re-run). Supports private registries, MysteryBox secret injection, injected config files, S3 volume mounts, and SSH access
- **`Nebius.ai.Endpoint`** — Long-running inference endpoints with public/private addresses, optional auth token (inline or MysteryBox secret), and start/stop lifecycle

### Networking (VPC)

Build complete software-defined network topologies.

- **`Nebius.vpc.Network`** — Software-defined networks with auto-generated default route tables
- **`Nebius.vpc.Subnet`** — Subnets with zone assignment and CIDR blocks
- **`Nebius.vpc.SecurityGroup`** — Firewall groups
- **`Nebius.vpc.SecurityRule`** — Stateful or stateless ingress/egress rules with protocol and port ranges
- **`Nebius.vpc.RouteTable`** — Custom route tables
- **`Nebius.vpc.Route`** — Static routes with CIDR destinations and next-hop gateways
- **`Nebius.vpc.Pool`** — IP address pools (IPv4, public or private)
- **`Nebius.vpc.Allocation`** — Individual IP allocations from a pool

### IAM & Access

Manage projects, service accounts, access keys, federation, groups, and permissions.

- **`Nebius.iam.Project`** — Tenant projects
- **`Nebius.iam.ServiceAccount`** — Machine identities for programmatic access
- **`Nebius.iam.StaticKey`** — Long-lived static credentials (token only at creation time)
- **`Nebius.iam.AccessKey`** — S3-compatible access keys (v2 API with MysteryBox delivery)
- **`Nebius.iam.Federation`** — SAML/OIDC identity federation
- **`Nebius.iam.FederationCertificate`** — X.509 certificates for federations
- **`Nebius.iam.Group`** — Access groups
- **`Nebius.iam.GroupMembership`** — Group member assignments
- **`Nebius.iam.AccessPermit`** — Resource-level role grants (group-scoped)
- **`Nebius.iam.Invitation`** — User invitations with resend support
- **`Nebius.iam.AuthPublicKey`** — SSH public keys for authentication
- **`Nebius.iam.FederatedCredentials`** — Federated credential bindings

### Storage

- **`Nebius.storage.Bucket`** — S3-compatible object storage buckets
- **`Nebius.storage.Transfer`** — Data transfer operations with iteration history

### DNS

- **`Nebius.dns.Zone`** — VPC-scoped DNS zones with custom domains
- **`Nebius.dns.Record`** — A, AAAA, CNAME, TXT, MX, and other record types

### KMS

- **`Nebius.kms.SymmetricKey`** — AES-256 encryption keys
- **`Nebius.kms.AsymmetricKey`** — ECDSA and RSA signing/encryption keys

### Secrets (MysteryBox)

- **`Nebius.mysterybox.Secret`** — Versioned secret storage with KMS encryption and inline payloads
- **`Nebius.mysterybox.SecretVersion`** — Secret versions with primary-version promotion

### Quotas

- **`Nebius.quotas.QuotaAllowance`** — Project quota management by region

### Discovery Actions

[Alchemy actions](https://alchemy.run/infrastructure-as-code/action/) for discovering existing resources without adopting them. Useful in `alchemy plan` for auditing.

- `Nebius.iam.action.ListProjects` / `GetProject`
- `Nebius.iam.action.ListGroups` / `GetGroup`
- `Nebius.vpc.action.ListNetworks` / `GetNetwork`
- `Nebius.vpc.action.ListSubnets` / `GetSubnet`
- `Nebius.vpc.action.ListRouteTables` / `GetRouteTable`
- `Nebius.quotas.action.ListQuotas` / `GetQuota`
- `Nebius.capacity.action.ListResourceAdvice` — read-only capacity advice per `(region, fabric, platform, preset)`, with availability split by capacity class (reserved / on-demand / preemptible) and your quota limit. **It is the in-API source of InfiniBand fabric ids**, which `Nebius.compute.GpuCluster`'s required `infinibandFabric` prop needs. The advisor is `list`-only and tenant-scoped; filters (`region` / `platform` / `preset`) are applied client-side:

```ts
const rows = yield* Nebius.capacity.action.ListResourceAdvice({ region: 'eu-north1', platform: 'gpu-h200-sxm' })
const fabrics = [...new Set(rows.map((row) => row.fabric))]     // e.g. ['fabric-7']
const room = rows.find((row) => row.fabric === 'fabric-7')?.onDemand?.available ?? 0
```

## Bindings

**Bindings** are typed runtime clients you attach to **your own compute host** — a **Nebius Instance by default**, or a Cloudflare Worker (`Cloudflare.Worker` is the compatibility wrapper). No Nebius Function host required. One declaration derives three things at deploy time:

1. **Credential minting + least-privilege grant** on Nebius — a per-host service account holding an S3 access key, placed in its own `<host>BindingGroup` (not the tenant's `editors` group), plus one **bucket-scoped** `iam.AccessPermit` per capability: `storage.viewer` for reads, `storage.editor` for writes. No project-wide role is granted,
2. **env injection** into the host's runtime env — `plain_text`/`secret_text` bindings on a Worker, the shipped `EnvironmentFile` on an Instance,
3. a **typed runtime client** (s3-lite-client, fetch-based) reading those env values.

```ts
// alchemy.run.ts — the Nebius Instance is its own binding host.

import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

const bucket = yield* Nebius.storage.Bucket('Assets')

yield* Nebius.compute.Instance(
  'Api',
  {
    // The program bundled onto the VM (see below).
    main: new URL('./program.ts', import.meta.url).href,
    /* … serviceAccountId, resources, bootDisk, networkInterfaces … */
  },
  Effect.gen(function* () {
    // DEPLOY TIME. The VM never runs this init Effect: it mints the host
    // identity, grants bucket access, and injects `NEBIUS_S3_*` into the
    // instance's systemd `EnvironmentFile`.
    yield* Nebius.storage.GetObject(bucket).pipe(Effect.provide(Nebius.storage.GetObjectHttp))
    yield* Nebius.storage.PutObject(bucket).pipe(Effect.provide(Nebius.storage.PutObjectHttp))
  }),
)
```

`program.ts` is what actually runs on the VM. It *consumes* the binding — the
credentials are already in `process.env`, so it passes a plain `ref` handle and
the same `*Http` layer:

```ts
// program.ts — bundled onto the VM (deep imports keep the bundle small).

import * as Effect from 'effect/Effect'
import { NebiusBucket } from '@fllstck/nebius-alchemy/resources/storage/v1/bucket.ts'
import { GetObject, GetObjectHttp } from '@fllstck/nebius-alchemy/resources/storage/v1/bindings.ts'

const program = Effect.gen(function* () {
  const bucket = yield* NebiusBucket.ref('Assets')
  const getObject = yield* GetObject(bucket).pipe(Effect.provide(GetObjectHttp))

  return { fetch: /*...*/ }
})
```

On a **Cloudflare Worker** the same declaration is the compatibility-wrapper
form — same contract, same `*Http` layer, the host just registers Cloudflare env
bindings instead of an env file:

```ts
// api.ts

import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { NebiusBucket } from '@fllstck/nebius-alchemy/resources/storage/v1/bucket.ts'
import * as StorageBindings from '@fllstck/nebius-alchemy/resources/storage/v1/bindings.ts'

export const Api = Cloudflare.Worker(
  'Api',
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* NebiusBucket('assets')

    const getObject = yield* StorageBindings.GetObject(bucket)
    const putObject = yield* StorageBindings.PutObject(bucket)

    return {
      fetch: /*...*/,
    }
  }).pipe(Effect.provide(Layer.mergeAll(StorageBindings.GetObjectHttp, StorageBindings.PutObjectHttp))),
)
```

Currently available (the `*Http` layers are host-agnostic):

| Contract                    | Layer                           | Runtime                                             |
| --------------------------- | ------------------------------- | --------------------------------------------------- |
| `Nebius.storage.GetObject`  | `Nebius.storage.GetObjectHttp`  | s3-lite-client (`GET object`)                       |
| `Nebius.storage.PutObject`  | `Nebius.storage.PutObjectHttp`  | s3-lite-client (`PUT object`)                       |
| `Nebius.ai.ChatCompletions` | `Nebius.ai.ChatCompletionsHttp` | fetch OpenAI-compatible `POST /v1/chat/completions` |

### AI endpoint bindings

`Nebius.ai.ChatCompletions(endpoint)` derives the endpoint's public URL and
bearer token at deploy time and gives the host a typed, fetch-based
OpenAI-compatible client (`ChatCompletionRequest` → `ChatCompletion`, or an
SSE stream of `ChatCompletionChunk`s with `stream: true`). The token deploys
as a Cloudflare `secret_text` binding (on an Instance host it lands in the
shipped `EnvironmentFile`); auth is a bearer token, so — unlike the S3
bindings — there is no identity minting or IAM grant. Env derivation is
deliberately **lenient**: an endpoint that is not RUNNING yet yields an empty
`NEBIUS_ENDPOINT_URL` (a fail-fast here would fire during `alchemy plan`
against persisted output and block the deploy), so the provider waits for
readiness and the first *call* with an empty URL fails with
`EndpointNotRunning`. See [AI_BINDINGS.md](AI_BINDINGS.md) for the design
and [`examples/ai.bindings.ts`](examples/ai.bindings.ts) for a full example.

### Bindings env reference

Injected into the host's runtime env at deploy time (names are stable). Secrets
are Cloudflare `secret_text` bindings on a Worker, and plaintext in the
`EnvironmentFile` on an Instance host:

| Env var                      | Meaning                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `NEBIUS_S3_ENDPOINT`         | `https://storage.<region>.nebius.cloud`                              |
| `NEBIUS_REGION`              | Region the access key was minted in                                  |
| `NEBIUS_ACCESS_KEY_ID`       | AWS-style access key id (plain text)                                 |
| `NEBIUS_SECRET_ACCESS_KEY`   | Secret access key (`secret_text` on a Worker)                        |
| `NEBIUS_BUCKET_NAME`         | The bound bucket's name                                              |
| `NEBIUS_ENDPOINT_URL`        | The endpoint's first public URL (AI bindings)                        |
| `NEBIUS_ENDPOINT_AUTH_TOKEN` | The endpoint's bearer token (`''` when auth disabled)                |

See [`examples/ai-chat-instance.ts`](examples/ai-chat-instance.ts) for the
instance-host pattern end to end, and
[`examples/storage.bindings.ts`](examples/storage.bindings.ts) +
[`examples/storage.bindings-worker.ts`](examples/storage.bindings-worker.ts)
for the Worker-host one.

> **Bindings on a Nebius Instance** (the native host — no Cloudflare account
> needed): [`examples/ai-chat-instance.ts`](examples/ai-chat-instance.ts) is the
> full working version of the pattern above — a GPU endpoint plus a hosted
> instance whose program consumes the same typed `ChatCompletions` client. The
> program (which the VM fetches and runs) reads the injected env; the binding is
> registered only by the stack's inline init Effect. Billable + slow: see the
> file header.

> **Small-bundle variant**: the Effect-native worker bundles alchemy's runtime. If bundle size matters more than the typed contracts, use [`examples/storage-async.bindings.ts`](examples/storage-async.bindings.ts).

> **Worker support is the compatibility wrapper.** The Nebius Instance is the
> default host, and the Worker path is kept deliberately (removing it would be a
> breaking change). It is regression-gated by the suite, which exercises the
> Cloudflare `{ bindings: [...] }` payload against a *mock* host — there is no
> real-Cloudflare deploy in CI, so this is the one arm with mock-level coverage only.

## Examples

| Example                                                        | What it demonstrates                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`examples/storage.ts`](examples/storage.ts)                   | Minimal bucket — the simplest possible stack                                                                                                                                                                                                                                                                                                                                                                      |
| [`examples/vpc.ts`](examples/vpc.ts)                           | Full VPC topology: network, subnet, routes, security group, IPAM                                                                                                                                                                                                                                                                                                                                                  |
| [`examples/compute.ts`](examples/compute.ts)                   | GPU instance: dynamic image lookup → disk → preemptible H200 instance                                                                                                                                                                                                                                                                                                                                             |
| [`examples/iam.ts`](examples/iam.ts)                           | Service account with static key                                                                                                                                                                                                                                                                                                                                                                                   |
| [`examples/dns.ts`](examples/dns.ts)                           | VPC-scoped DNS zone with A record                                                                                                                                                                                                                                                                                                                                                                                 |
| [`examples/kms.ts`](examples/kms.ts)                           | Symmetric and asymmetric encryption keys                                                                                                                                                                                                                                                                                                                                                                          |
| [`examples/mysterybox.ts`](examples/mysterybox.ts)             | Versioned secret with payload rotation                                                                                                                                                                                                                                                                                                                                                                            |
| [`examples/actions.ts`](examples/actions.ts)                   | Read-only discovery actions for IAM, VPC, and quotas                                                                                                                                                                                                                                                                                                                                                              |
| [`examples/storage.bindings.ts`](examples/storage.bindings.ts) | Nebius S3 bindings for a Cloudflare Worker (Get/Put object)                                                                                                                                                                                                                                                                                                                                                       |
| [`examples/ai.bindings.ts`](examples/ai.bindings.ts)           | Nebius AI endpoint bindings for a Cloudflare Worker (ChatCompletions)                                                                                                                                                                                                                                                                                                                                             |
| [`examples/ai-chat-instance.ts`](examples/ai-chat-instance.ts) | **Hosted Nebius instance** running an Effect program: OpenAI-compatible endpoint + `ChatCompletions` binding → `curl 'http://<ip>:3000/?prompt=…'` returns a real completion (`&stream=1` streams SSE). Defaults to a cheap **CPU** endpoint (llama.cpp + 0.5B model); the GPU vLLM config is a commented alternative. The instance-host counterpart of `ai.bindings.ts` (`…-program.ts` is what the VM executes) |

## Usage

```bash
# Preview changes
bun alchemy plan

# Deploy
bun alchemy deploy

# Tear down
bun alchemy destroy

# Clear all
bun alchemy unsafe nuke
```

Resources follow the namespace hierarchy `Nebius.<service>.<Resource>`:

```ts
const bucket = yield* Nebius.storage.Bucket('MyBucket')
const network = yield* Nebius.vpc.Network('MyNetwork')
const instance = yield* Nebius.compute.Instance('MyInstance', { ... })
```

Names are auto-generated from logical IDs when omitted.

## Development

```bash
bun run check             # typecheck + lint
bun test                  # unit tests only — network-free (see below)
bun run test:integration  # SLOW_TESTS=1 bun test tests/ — everything
bun run generate:schemas  # regenerate protobuf schemas from .proto files
```

### Testing & the `SLOW_TESTS` flag

A plain `bun test` (no env vars) is **guaranteed network-free**: every test that deploys/destroys real Nebius resources or opens a real gRPC channel is gated behind the `SLOW_TESTS` flag and is reported as `skip`.

```bash
bun test                       # unit tests only — zero network I/O
SLOW_TESTS=1 bun test tests/   # full suite incl. real resource lifecycles
bun run test:integration       # shorthand for the above
```

> The flag lives in a single place — `tests/helpers/gate.ts` (`runIntegration()` / `integrationTest()`). Integration tests additionally require real Nebius credentials — `NEBIUS_API_KEY`, or a stored profile (`alchemy profile edit --add Nebius`). The `NEBIUS_SA_*` key triple is read **only** when `CI=true`, so it does not apply to a local `SLOW_TESTS` run; api-client tests skip when credentials aren't resolvable. Destroy cleanup uses `safeDestroy()` from `tests/helpers/cleanup.ts` — a failed destroy fails the test when the body succeeded, and logs (redacted) without masking the body's own failure otherwise.

## Architecture

Built on **Effect V4** and **Alchemy V2** with typed gRPC/protobuf clients for every Nebius API service. The provider uses Alchemy's resource lifecycle (`reconcile`, `delete`, `diff`, `read`) with factory helpers for standard CRUD operations. Protobuf schemas live under `schemas/` and are generated from [the Nebius API `.proto` files](https://github.com/nebius/api) via `buf generate`.
