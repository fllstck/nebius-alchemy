# Nebius AI Cloud for Alchemy

Build Nebius cloud infrastructure as typed [Effect](https://effect.website) programs. GPU compute, VPC networks, IAM, object storage, DNS, KMS, and secrets — all in one TypeScript program, deployed with [Alchemy](https://v2.alchemy.run).

```bash
bun add @fllstck/nebius-alchemy alchemy@next effect@next
```

## Quick Start

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

```bash
alchemy deploy --yes
```

## Consuming

### Peer Dependencies

The package ships raw TypeScript source and requires these peer dependencies installed in your project:

| Package                  | Required | Notes                                |
| ------------------------ | -------- | ------------------------------------ |
| `effect`                 | Yes      | Effect V4 runtime (`>=4.0.0-beta.100` or `>=4.0.0`) |
| `@effect/platform-bun`   | Yes      | Bun platform bindings                |
| `@effect/platform-node`  | Yes      | Required by Alchemy CLI              |
| `typescript`             | Yes      | TypeScript 7 (`^7.0.0`)              |
| `alchemy`                | Yes      | Alchemy V2 (`@next` tag)             |

```bash
bun add @fllstck/nebius-alchemy alchemy@next effect@beta @effect/platform-bun@beta @effect/platform-node@beta typescript
```

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

| Variable            | Required | Description                                   |
| ------------------- | -------- | --------------------------------------------- |
| `NEBIUS_API_KEY`    | Yes      | IAM API key (auto-populated from Nebius CLI)  |
| `NEBIUS_PROJECT_ID` | Yes      | Nebius project ID                             |
| `NEBIUS_TENANT_ID`  | —        | Tenant ID for project/group discovery actions |
| `NEBIUS_REGION`     | —        | Default region (defaults to `eu-north1`)      |

## Resources

### Compute

Deploy GPU-accelerated instances, disks, and managed filesystems.

- **`Nebius.compute.Instance`** — GPU VMs with H200 support, preemptible instances, custom boot disks and network interfaces
- **`Nebius.compute.Disk`** — Network SSD and HDD disks, bootable from images or snapshots
- **`Nebius.compute.Image`** — Dynamic image lookup by family (`ubuntu-22-04-lts`, etc.)
- **`Nebius.compute.Filesystem`** — Managed NFS filesystems
- **`Nebius.compute.DiskSnapshot`** — Point-in-time disk snapshots

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

## Usage

```bash
# Preview changes
alchemy plan

# Deploy
alchemy deploy --yes

# Tear down
alchemy destroy --yes
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
bun test                  # unit + integration tests
bun run generate:schemas  # regenerate protobuf schemas from .proto files
```

## Architecture

Built on **Effect V4** and **Alchemy V2** with typed gRPC/protobuf clients for every Nebius API service. The provider uses Alchemy's resource lifecycle (`reconcile`, `delete`, `diff`, `read`) with factory helpers for standard CRUD operations. Protobuf schemas live under `schemas/` and are generated from the Nebius API `.proto` files via `buf generate`.
