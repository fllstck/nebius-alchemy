# Nebius AI Cloud for Alchemy

Build Nebius cloud infrastructure as typed [Effect](https://effect.website) programs. GPU compute, VPC networks, IAM, object storage, DNS, KMS, and secrets — all in one TypeScript program, deployed with [Alchemy](https://v2.alchemy.run).

## Quick Start

You need [a Nebius account](https://nebius.com/).

```bash
bun add @fllstck/nebius-alchemy alchemy@next effect@beta @effect/platform-bun@beta @effect/platform-node@beta typescript
```

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

Configure the project you want to deploy to.

```
// .env

NEBIUS_PROJECT_ID=<YOUR_RROJECT_ID>
```

Set the API key for the Nebius AI Cloud API. This can be done via the Nebius CLI or by manually entering a key.

```bash
bun alchemy login
```

Deploy the bucket.

```bash
alchemy deploy
```

Delete the bucket.

```bash
alchemy destroy
```

### Peer Dependencies

The package ships raw TypeScript source and requires these peer dependencies installed in your project:

| Package                 | Required | Notes                                               |
| ----------------------- | -------- | --------------------------------------------------- |
| `effect`                | Yes      | Effect V4 runtime (`>=4.0.0-beta.100` or `>=4.0.0`) |
| `@effect/platform-bun`  | Yes      | Bun platform bindings                               |
| `@effect/platform-node` | Yes      | Required by Alchemy CLI                             |
| `typescript`            | Yes      | TypeScript 7 (`^7.0.0`)                             |
| `alchemy`               | Yes      | Alchemy V2 (`@next` tag)                            |

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

## Prerequisites

| Variable            | Required | Description                                            |
| ------------------- | -------- | ------------------------------------------------------ |
| `NEBIUS_API_KEY`    | Yes      | IAM API key (auto-populated from Nebius CLI)           |
| `NEBIUS_PROJECT_ID` | Yes      | Nebius project ID                                      |
| `NEBIUS_TENANT_ID`  | —        | Tenant ID for project/group discovery/creation actions |
| `NEBIUS_REGION`     | —        | Default region (defaults to `eu-north1`)               |

## Resources

All resources that currently are currently implemented.

### Compute

Deploy GPU-accelerated instances, disks, and managed filesystems.

- **`Nebius.compute.Instance`** — GPU VMs with H200 support, preemptible instances, custom boot disks and network interfaces
- **`Nebius.compute.Disk`** — Network SSD and HDD disks, bootable from images or snapshots
- **`Nebius.compute.Image`** — Dynamic image lookup by family (`ubuntu-22-04-lts`, etc.)
- **`Nebius.compute.Filesystem`** — Managed NFS filesystems
- **`Nebius.compute.DiskSnapshot`** — Point-in-time disk snapshots

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

Read-only actions for discovering existing resources without managing them. Useful in `alchemy plan` for auditing.

- `Nebius.iam.action.ListProjects` / `GetProject`
- `Nebius.iam.action.ListGroups` / `GetGroup`
- `Nebius.vpc.action.ListNetworks` / `GetNetwork`
- `Nebius.vpc.action.ListSubnets` / `GetSubnet`
- `Nebius.vpc.action.ListRouteTables` / `GetRouteTable`
- `Nebius.quotas.action.ListQuotas` / `GetQuota`

## Bindings

**Bindings** are typed runtime clients you attach to **your own Cloudflare
Worker** — no Nebius Function host required. One declaration derives three
things at deploy time:

1. **Credential minting + least-privilege grant** on Nebius (a service account
   added to your tenant's default `editors` group + a region-scoped access
   key),
2. **env injection** into the Worker as `plain_text`/`secret_text` bindings,
3. a **typed runtime client** (s3-lite-client, fetch-based) reading those env
   values.

```ts
const Api = Cloudflare.Worker(
  'Api',
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket('assets')
    const getObject = yield* Nebius.storage.GetObject(bucket)
    const putObject = yield* Nebius.storage.PutObject(bucket)
    return { fetch: /* getObject/putObject */ }
  }).pipe(Effect.provide(Layer.mergeAll(
    Nebius.storage.GetObjectHttp,
    Nebius.storage.PutObjectHttp,
  ))),
)
```

Currently available (Cloudflare Workers):

| Contract                  | Layer                          | Runtime                          |
| ------------------------- | ------------------------------ | -------------------------------- |
| `Nebius.storage.GetObject` | `Nebius.storage.GetObjectHttp` | s3-lite-client (`GET object`) |
| `Nebius.storage.PutObject` | `Nebius.storage.PutObjectHttp` | s3-lite-client (`PUT object`) |

**Roadmap**: AWS Lambda/ECS/EKS hosts are a documented extension point — the
same contracts with `*Http` layers pushing `{ env }` instead of CF bindings.
AI endpoint bindings (`ChatCompletions`) are deferred.

### Bindings env reference

Injected into the Worker at deploy time (names are stable):

| Env var                    | Meaning                                       |
| -------------------------- | --------------------------------------------- |
| `NEBIUS_S3_ENDPOINT`       | `https://storage.<region>.nebius.cloud`       |
| `NEBIUS_REGION`            | Region the access key was minted in           |
| `NEBIUS_ACCESS_KEY_ID`     | AWS-style access key id (plain text)          |
| `NEBIUS_SECRET_ACCESS_KEY` | Secret access key (deployed as `secret_text`) |
| `NEBIUS_BUCKET_NAME`       | The bound bucket's name                       |

See [`examples/bindings.ts`](examples/bindings.ts) for the full pattern.

**Small-bundle variant**: the Effect-native worker bundles alchemy's runtime
(~2 MB). If bundle size matters more than the typed contracts, use
[`examples/bindings-async.ts`](examples/bindings-async.ts) — the same
identity chain declared as stack resources (SA → editors grant → key), with
their outputs passed via the Worker's **`env` prop** (alchemy's native async
binding pattern; `Redacted` → `secret_text`). The plain async worker
(`main` + `fetch`) reads the injected `NEBIUS_S3_*` env with s3-lite-client
directly — typically ~50-150 KB.

## Examples

| Example                                            | What it demonstrates                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| [`examples/storage.ts`](examples/storage.ts)       | Minimal bucket — the simplest possible stack                          |
| [`examples/vpc.ts`](examples/vpc.ts)               | Full VPC topology: network, subnet, routes, security group, IPAM      |
| [`examples/compute.ts`](examples/compute.ts)       | GPU instance: dynamic image lookup → disk → preemptible H200 instance |
| [`examples/iam.ts`](examples/iam.ts)               | Service account with static key                                       |
| [`examples/dns.ts`](examples/dns.ts)               | VPC-scoped DNS zone with A record                                     |
| [`examples/kms.ts`](examples/kms.ts)               | Symmetric and asymmetric encryption keys                              |
| [`examples/mysterybox.ts`](examples/mysterybox.ts) | Versioned secret with payload rotation                                |
| [`examples/actions.ts`](examples/actions.ts)       | Read-only discovery actions for IAM, VPC, and quotas                  |
| [`examples/bindings.ts`](examples/bindings.ts)     | Nebius S3 bindings for a Cloudflare Worker (Get/Put object)           |

## Usage

```bash
# Preview changes
alchemy plan

# Deploy
alchemy deploy

# Tear down
alchemy destroy
```

Resources follow the namespace hierarchy `Nebius.<service>.<Resource>`:

```ts
const bucket = yield* Nebius.storage.Bucket('MyBucket')
const network = yield* Nebius.vpc.Network('MyNetwork')
const instance = yield* Nebius.compute.Instance('MyInstance', { ... })
```

Names are auto-generated from logical IDs when omitted — no need to invent unique physical names.

## Development

```bash
bun run check             # typecheck + lint
bun test                  # unit tests only — network-free (see below)
bun run test:integration  # SLOW_TESTS=1 bun test tests/ — everything
bun run generate:schemas  # regenerate protobuf schemas from .proto files
```

### Testing & the `SLOW_TESTS` flag

A plain `bun test` (no env vars) is **guaranteed network-free**: every test that
deploys/destroys real Nebius resources or opens a real gRPC channel is gated
behind the `SLOW_TESTS` flag and is reported as `skip`.

```bash
bun test                       # unit tests only — zero network I/O
SLOW_TESTS=1 bun test tests/   # full suite incl. real resource lifecycles
bun run test:integration       # shorthand for the above
```

The flag lives in a single place — `tests/helpers/gate.ts` (`runIntegration()` /
`integrationTest()`). Integration tests additionally require real Nebius
credentials (env / stored / CLI); api-client tests skip when credentials aren't
resolvable. Destroy cleanup uses `safeDestroy()` from `tests/helpers/cleanup.ts`
— a failed destroy fails the test when the body succeeded, and logs (redacted)
without masking the body's own failure otherwise.

## Architecture

Built on **Effect V4** and **Alchemy V2** with typed gRPC/protobuf clients for every Nebius API service. The provider uses Alchemy's resource lifecycle (`reconcile`, `delete`, `diff`, `read`) with factory helpers for standard CRUD operations. Protobuf schemas live under `schemas/` and are generated from the Nebius API `.proto` files via `buf generate`.
