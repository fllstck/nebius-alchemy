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
bun add alchemy@2.0.0-beta.79 effect@4.0.0-rc.117 @effect/platform-bun@4.0.0-rc.117 @effect/platform-node@4.0.0-rc.117 @fllstck/nebius-alchemy
```

> **Versions are pinned exactly, and that is deliberate.** Alchemy and Effect must
> move together — alchemy pins the Effect release it compiles against, and a
> mismatch fails at import. `alchemy@2.0.0-beta.79` requires
> `effect@4.0.0-rc.117`.
>
> **Why `rc.117` and not `rc.115`:** `@effect/platform-node@rc.115` declares
> `@effect/platform-node-shared: ^4.0.0-rc.115` — a range that resolves _upward_ to
> the newest prerelease. Once rc.117 existed, bun (which ignores peer ranges)
> resolved the shared package to rc.117 while `effect` stayed rc.115: a mixed
> family. Pinning the whole constellation to the newest release is what keeps one
> `@effect/*` version in the tree — verify it after any dependency change:
> `npm ls @effect/*` (or `bun pm ls`) must print one line per package. Three
> `@effect/sql-*` packages shipped on the Effect 3 line until 0.9.1, so every install
> carried two versions of each. A newer `rc` will reintroduce the drift, so
> re-audit after every bump — see `agent-patterns/effect-versioning.md`.
>
> **Avoid `alchemy@next`.** The `next` dist-tag currently points at an _older_
> beta (`2.0.0-beta.72`) than `latest` (`2.0.0-beta.79`). Since 0.9.1 `alchemy` is a **peer** of this
> package, pinned to the exact beta — so installing a different one now fails loudly
> (`ERESOLVE … peer alchemy@"2.0.0-beta.79"`) instead of silently installing two copies, where the
> CLI and the providers would each use their own `alchemy` and their own Effect instance.
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

`typescript` is the exception to the exact-pin rule below, and deliberately so: declaring a compiler
_range_ as a peer makes a plain `npm install` fail, because npm then has to place a compiler version
next to alchemy's optional frontend chains (`octane`, `@xata.io/client`, …), which ask for TypeScript
5.x — `ERESOLVE … peerOptional typescript@">=6 <8"`. So this package declares **no** TypeScript
dependency or peer at all: **bring your own** compiler (6 or 7 is verified: 6.0.3, 7.0.2), configured
as shown in § tsconfig.json.
Versions are **pinned exactly** — alchemy and Effect move together, so a mismatched pair fails
at import (see _Install Dependencies_ above):

| Package                        | Required          | Pinned to                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                       | Yes               | `4.0.0-rc.117`                                                                                                                                                                                                                                                                                  |
| `@effect/platform-bun`         | Yes               | `4.0.0-rc.117`                                                                                                                                                                                                                                                                                  |
| `@effect/platform-node`        | Yes               | `4.0.0-rc.117` — required by the Alchemy CLI                                                                                                                                                                                                                                                    |
| `@effect/platform-node-shared` | Yes               | `4.0.0-rc.117` — declared exact so npm resolves the whole `@effect/*` family consistently                                                                                                                                                                                                       |
| `typescript`                   | Not declared      | Bring TypeScript 6 or 7 (verified: 6.0.3, 7.0.2). It was a `>=6 <8` **optional** peer until 0.9.1, which made `npm install` fail against alchemy's optional TypeScript-5 chains (`ERESOLVE … peerOptional typescript`) — a compiler range here can only break installs, so the choice is yours. |
| `alchemy`                      | Yes (peer, exact) | `2.0.0-beta.79` — the `latest` tag. **Not** `@next`, which is an _older_ beta. Exact on purpose: the CLI and this package's providers must share one `alchemy` (and one Effect instance), so a mismatch is an install error rather than two copies                                              |

### Upgrading from 0.9.x

**One behaviour change, and four new resources.**

- **`labels` now converge on update** (28 resources — every one with an update path). Every update carries
  the full label map (internal ownership tags + yours), and a change to _labels alone_ now triggers that
  update. So: a label **removed from your configuration is deleted in the cloud** (it used to survive until
  something unrelated rewrote the resource), and a label added **out of band** (console, script) is dropped
  by the next update, because the map is replaced rather than merged. Configurations you did not change are
  unaffected — the trigger only fires when a declared label is missing/different, or one you declared
  before is gone. The few resources that cannot converge labels (no `Update` RPC, or a service that
  discards them) are listed per resource in the convergence sweep.
- **New resources:** `Nebius.mk8s.Cluster`, `Nebius.mk8s.NodeGroup`, `Nebius.billing.PricingPolicy`, plus
  the read-only `Nebius.capacity.action.*` discovery actions and two new brands
  (`Nebius.billing.PricingPolicyId`, `Nebius.capacity.CapacityBlockGroupId`).
- **Spot pricing is expressible** via `pricing` on `compute.Instance`, `mk8s.NodeGroup.template`, `ai.Job`
  and `ai.Endpoint` — `{ onDemand: true }`, `{ followsSpotPrice: true }` or
  `{ spotPricingPolicy: { id } }`. The API's requirement that the arm match `preemptible` is a plan-time
  error. Two measured caveats: on `compute.Instance` a pricing change is only accepted on a **stopped**
  instance, and on `mk8s.NodeGroup` it is treated as a template change (expect a node roll-out).
- **`Nebius.billing.PricingPolicy` has two sharp edges from the API:** its service **discards**
  `metadata.labels` (accepted and ignored; every read reports `Unowned`), and its `Update` RPC rejects every
  documented request shape, so any spec change is planned as a **replace**.
- **`mk8s.NodeGroup` attributes** gained the effective `maxUnavailable` / `maxSurge` /
  `drainTimeoutSeconds` (read from `status`, where the platform reports what it is actually using).

### Upgrading from 0.8.x

**0.9.0** changed four things a consumer can feel; the rest of that release is behaviour fixes.

- **Seven attributes are strings, and are now typed as such.** In `0.8.x`
  `FilesystemAttributes.{sizeGibibytes,blockSizeBytes}`, `DiskAttributes.{sizeGibibytes,blockSizeBytes}`,
  `DiskSnapshotAttributes.{contentSizeBytes,storageSizeBytes}` and
  `FederationCertificateAttributes.keySize` were declared `number` while the runtime value was already
  `"4096"`. Wrap them in `Number(...)` (or `BigInt(...)`) where you do arithmetic — code written against
  the old type now fails to compile instead of concatenating silently.
- **`Nebius.storage.v1.Transfer` requires `source.nebius.accessKey`.** The API rejects a Nebius source
  without it (`3 INVALID_ARGUMENT`, for every stop condition), so a missing key is now a plan-time error
  instead of an apply-time one.
- **`Nebius.iam.v1.AuthPublicKey.data` must be an RSA-4096 public key** — the only shape the service
  accepts (RSA-2048/3072 and every non-RSA key are refused).
- **`Nebius.vpc.v1.SecurityRule` requires the match block its `direction` selects** (`ingress` for
  INGRESS, `egress` for EGRESS) — the API derives the direction from that block, so a rule declaring a
  direction without it could not express it at all.

**0.9.1** stopped shipping three `@effect/sql-*` packages. `@effect/sql-d1`, `@effect/sql-sqlite-do`
and `@effect/vitest` are **alchemy's** dependencies (the Effect 4 line), and this package's copies pinned
Effect **3** — so an install contained both lines and npm printed four
`ERESOLVE overriding peer dependency` warnings. If you were relying on those arriving through this
package, install them in your own project at the Effect 4 line (`4.0.0-rc.117`).

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

Per-prop detail — required vs optional, the type of each prop, and every **plan-time validation** — is in
[**RESOURCES.md**](RESOURCES.md), generated from the schemas (each heading below links to its entry there).
The prose here is the narrative: what the resource is for, and what has been measured against real infra.

All resources use the `NEBIUS_PROJECT_ID` environment variable as default `parentId` where appropriate.

### Compute

Deploy GPU-accelerated instances, disks, and managed filesystems.

- **[`Nebius.compute.Instance`](RESOURCES.md#nebiuscomputeinstance)** — GPU VMs with H200 support, preemptible instances, custom boot disks and network interfaces
- **[`Nebius.compute.Disk`](RESOURCES.md#nebiuscomputedisk)** — Network SSD and HDD disks, bootable from images or snapshots
- **[`Nebius.compute.Image`](RESOURCES.md#nebiuscomputeimage)** — Dynamic image lookup by family (`ubuntu-22-04-lts`, etc.)
- **[`Nebius.compute.Filesystem`](RESOURCES.md#nebiuscomputefilesystem)** — Managed NFS filesystems
- **[`Nebius.compute.DiskSnapshot`](RESOURCES.md#nebiuscomputedisksnapshot)** — Point-in-time disk snapshots
- **[`Nebius.compute.GpuCluster`](RESOURCES.md#nebiuscomputegpucluster)** — InfiniBand GPU clusters. The spec is a single immutable field (`infinibandFabric`), so any change replaces the cluster; `instances` is read-only (membership is declared on the Instance via `gpuCluster.id`), and deleting a cluster that still has members fails with `GpuClusterNotEmpty` naming them. **Verified against real infra (2026-09-18)**: create 1.6 s, delete 3.2 s, no leak, no GPU quota, no cost
- **[`Nebius.compute.NVLInstanceGroup`](RESOURCES.md#nebiuscomputenvlinstancegroup)** — NVLink instance groups (`GB200`/`GB300` racks). `type` is immutable (a change replaces); `size` is the maximum member count and adjusts in place; `instances` is read-only (membership is declared on the Instance via `nvlInstanceGroupId`), and deleting a non-empty group fails with `NVLInstanceGroupNotEmpty`
- **[`Nebius.mk8s.NodeGroup`](RESOURCES.md#nebiusmk8snodegroup)** — Worker node groups (the _CPU_ surface: sizing, `strategy`, `autoRepair` and the whole `template` — OS, hardware, boot disk, network interfaces, service account, cloud-init). The parent is the **cluster**, not the project, so `parentId` is required and there is no project fallback; deleting the cluster cascades to its node groups. **Exactly one** of `fixedNodeCount` / `autoscaling` must be set. `strategy.maxUnavailable`/`maxSurge` take _either_ `{ count }` or `{ percent }` (an integer 1–100); `strategy.drainTimeoutSeconds` and `autoRepair.conditions[].timeoutSeconds` are whole seconds (a `Duration` reshape — `0` is rejected, because a zero duration encodes as an absent field and would silently never apply). Read the **effective** strategy from `status`, not from your props: with `strategy` omitted the API answers its own defaults, which are migrating during Q3 2026. `template.os` and `resources.preset` are **not** validated against a list — which images a group may use depends on the cluster's Kubernetes version _and_ the platform, so `Nebius.mk8s.action.GetNodeGroupCompatibilityMatrix({ clusterKubernetesVersion, platform })` is the authority. The rest of the template: `template.metadata.labels` are **Kubernetes node labels** while `template.instanceMetadata.labels` are the **compute instances'** own metadata (two different maps — a label in the wrong one is invisible from the other side), and like `template.taints` and `template.cloudInitUserData` neither is **rolled out** to nodes that already exist, so a change needs a maintenance window; taints take `NO_EXECUTE`/`NO_SCHEDULE`/`PREFER_NO_SCHEDULE` with an optional (even empty) value; `template.filesystems[]` attaches an **existing** compute filesystem (`{ attachMode: 'READ_ONLY' | 'READ_WRITE', mountTag, existingFilesystem: { id } }`, mount tag ≤ 37 chars); `template.preemptible` and the two `template.localDisks` flags can only be turned **on** (`false` is a plan-time error); `template.maxPods` is optional (omit it and the platform's documented `110` applies server-side — measured live 2026-09-23, the default is **not** written back into `spec`, which keeps `0`) but cannot be `0`; and `template.reservationPolicy` takes `policy: 'FORBID' | 'STRICT'` (omit `policy` for AUTO — the proto's zero value cannot be sent as a change) with `reservationIds` from `Nebius.capacity.action.ListCapacityBlockGroups`. GPU placement: `template.gpuSettings` takes a `driversPreset` (the catalogue is the compatibility matrix — the same live query as `os`) and/or `dra: true` (Dynamic Resource Allocation; omit `driversPreset` for a driverless/DRA image), `template.gpuCluster.id` joins the nodes to a Compute GPU cluster's RDMA fabric, and `template.nvlink.nvlInstanceGroupId` (`GB200`/`GB300` racks) requires **fixed sizing** and **non-preemptible** nodes — the Nebius solutions library's preconditions, enforced at plan time because they are the two that are checkable locally (a driverfull image and no MIG/NUMA are documented at the field instead). An `nvlink` change is a roll-out, **not** a replace: measured 2026-09-23, the API accepts the field on an update and resolves the referenced group itself. `template.bootDisk.sizeGibibytes` is required (the platform's 64 GiB floor is enforced; a smaller disk hangs provisioning before cloud-init) and `template.networkInterfaces[].publicIpAddress` can only be turned **on** (`false` is a plan-time error). Omit `version` to inherit the cluster's resolved one. `template.cloudInitUserData` is **not** validated for an SSH key (the API accepts a key-less payload; the solutions library is what enforces one) and a change to it does **not** rewrite existing nodes — recreate nodes in a maintenance window. **Verified against real infra (2026-09-23)**: create → `RUNNING` with `nodeCount: 1`/`readyNodeCount: 1`, a forced reconcile wrote nothing (`resourceVersion` stayed `1`), node labels / instance-metadata labels / a taint round-tripped (the effect as its wire enum), a `fixedNodeCount` ⇄ `autoscaling` swap converged in place with the old side cleared, and the node group's `status.version` is the node image's own format `v1.36.3-nebius-node.75`. `template.filesystems`, `template.localDisks`, `template.reservationPolicy` and the GPU/NVLink arms are **not** live-verified (needs a mounted filesystem, a `GB200`/`GB300`-class platform, a capacity block group, and that same entitlement respectively — the NVLink arm has a gated test that documents what it would need)
- **[`Nebius.mk8s.Cluster`](RESOURCES.md#nebiusmk8scluster)** — Managed Kubernetes control planes. `subnetId` and `serviceCidrs` are create-only (a change plans a replace, because an in-place subnet change is answered with an opaque `13 INTERNAL` and does nothing); `version`, `etcdClusterSize`, `publicEndpoint`, `auditLogs` and `karpenter` update in place. Omit `version` unless you need to pin it — the backend default is what the solutions library recommends, and `status` reports what it resolved (`requestedVersion` is what you asked for, `version` is what is running). `auditLogs`/`karpenter` can only be turned **on** (`false` is a plan-time error: the proto models them as empty messages and the API has no `FieldMask`, so "absent" means "leave unchanged", never "disable"). Deleting a cluster **cascades** to its node groups, their instances and their disks. **Verified against real infra (2026-09-23)**: create → `RUNNING` in ~3 min with `etcdClusterSize: 1`, and a forced reconcile wrote nothing (`resourceVersion` stayed `1`), so no drift loop

> **Fabric ids come from the capacity advisor.** `infinibandFabric` is a
> _physical_ InfiniBand fabric in the target region; read the available ones with
> `Nebius.capacity.action.ListResourceAdvice({ region })` (see Discovery Actions
> below; `nebius capacity resource-advice list` shows the same data). **Fabrics are
> Nebius-provided infrastructure, not resources you create** — there is no Fabric
> service in the API and no CLI command for them; you create `GpuCluster`s that
> point at one (many per fabric), and each fabric serves exactly one platform
> (e.g. `fabric-7` → H200 only). So the prop stays a free string rather than a
> `Schema.Literal` union: a union of today's fabrics would go stale the moment
> Nebius lights up another one.
> Measured `eu-north1` → `fabric-2,3,4,6,7`; the API accepts these verbatim
> (proven: a cluster created with an advice-supplied fabric round-trips it).
> `Nebius.compute.NVLInstanceGroup` is **not** yet exercised against real infra —
> it needs a GB200/GB300 entitlement; its integration test is gated on
> `NEBIUS_TEST_NVL_GROUP=1`.

### AI

Run containerized AI workloads on Nebius AI Cloud. Neither resource supports
in-place updates — any spec change (or name change) replaces the resource.

- **[`Nebius.ai.Job`](RESOURCES.md#nebiusaijob)** — Run-to-completion container workloads (one run per resource; replace to re-run). Supports private registries, MysteryBox secret injection, injected config files, S3 volume mounts, and SSH access
- **[`Nebius.ai.Endpoint`](RESOURCES.md#nebiusaiendpoint)** — Long-running inference endpoints with public/private addresses, optional auth token (inline or MysteryBox secret), and start/stop lifecycle

### Networking (VPC)

Build complete software-defined network topologies.

- **[`Nebius.vpc.Network`](RESOURCES.md#nebiusvpcnetwork)** — Software-defined networks with auto-generated default route tables
- **[`Nebius.vpc.Subnet`](RESOURCES.md#nebiusvpcsubnet)** — Subnets with zone assignment and CIDR blocks
- **[`Nebius.vpc.SecurityGroup`](RESOURCES.md#nebiusvpcsecuritygroup)** — Firewall groups
- **[`Nebius.vpc.SecurityRule`](RESOURCES.md#nebiusvpcsecurityrule)** — Stateful or stateless ingress/egress rules with protocol and port ranges
- **[`Nebius.vpc.RouteTable`](RESOURCES.md#nebiusvpcroutetable)** — Custom route tables
- **[`Nebius.vpc.Route`](RESOURCES.md#nebiusvpcroute)** — Static routes with CIDR destinations and next-hop gateways
- **[`Nebius.vpc.Pool`](RESOURCES.md#nebiusvpcpool)** — IP address pools (IPv4, public or private)
- **[`Nebius.vpc.Allocation`](RESOURCES.md#nebiusvpcallocation)** — Individual IP allocations from a pool

### IAM & Access

Manage projects, service accounts, access keys, federation, groups, and permissions.

- **[`Nebius.iam.Project`](RESOURCES.md#nebiusiamproject)** — Tenant projects
- **[`Nebius.iam.ServiceAccount`](RESOURCES.md#nebiusiamserviceaccount)** — Machine identities for programmatic access
- **[`Nebius.iam.StaticKey`](RESOURCES.md#nebiusiamstatickey)** — Long-lived static credentials (token only at creation time)
- **[`Nebius.iam.AccessKey`](RESOURCES.md#nebiusiamaccesskey)** — S3-compatible access keys (v2 API with MysteryBox delivery)
- **[`Nebius.iam.Federation`](RESOURCES.md#nebiusiamfederation)** — SAML/OIDC identity federation
- **[`Nebius.iam.FederationCertificate`](RESOURCES.md#nebiusiamfederationcertificate)** — X.509 certificates for federations
- **[`Nebius.iam.Group`](RESOURCES.md#nebiusiamgroup)** — Access groups
- **[`Nebius.iam.GroupMembership`](RESOURCES.md#nebiusiamgroupmembership)** — Group member assignments. There is no `Update` RPC, so `revokeAfterHours` is create-only: changing it replaces the membership. No `name` prop — the API rejects `metadata.name` here
- **[`Nebius.iam.AccessPermit`](RESOURCES.md#nebiusiamaccesspermit)** — Resource-level role grants (group-scoped)
- **[`Nebius.iam.Invitation`](RESOURCES.md#nebiusiaminvitation)** — User invitations with resend support
- **[`Nebius.iam.AuthPublicKey`](RESOURCES.md#nebiusiamauthpublickey)** — SSH public keys for authentication
- **[`Nebius.iam.FederatedCredentials`](RESOURCES.md#nebiusiamfederatedcredentials)** — Federated credential bindings

### Storage

- **[`Nebius.storage.Bucket`](RESOURCES.md#nebiusstoragebucket)** — S3-compatible object storage buckets
- **[`Nebius.storage.Transfer`](RESOURCES.md#nebiusstoragetransfer)** — Data transfer operations with iteration history

### DNS

- **[`Nebius.dns.Zone`](RESOURCES.md#nebiusdnszone)** — VPC-scoped DNS zones with custom domains
- **[`Nebius.dns.Record`](RESOURCES.md#nebiusdnsrecord)** — A, AAAA, CNAME, TXT, MX, and other record types

### Billing

- **[`Nebius.billing.PricingPolicy`](RESOURCES.md#nebiusbillingpricingpolicy)** — a project-scoped auction bid (platform + max price per GPU hour) for **preemptible** GPU VMs, and the thing the `pricing` prop on `compute.Instance` / `mk8s.NodeGroup.template` / `ai.Job` / `ai.Endpoint` names through `spotPricingPolicy.id`. It provisions nothing, so it is the cheapest resource here to create and destroy. Two API sharp edges: the service **discards** `metadata.labels` (so `labels` is accepted and ignored, and every read reports `Unowned`), and its `Update` RPC rejects every documented request shape — so a change to `platform` or `maxPrice` is planned as a **replace**. **Verified against real infra (2026-09-24)**: create → `STATE_ACTIVE` with `SCHEDULING_STATE_ALLOWED`, a spec change via a `pricing`-only update accepted, delete clean

### KMS

- **[`Nebius.kms.SymmetricKey`](RESOURCES.md#nebiuskmssymmetrickey)** — AES-256 encryption keys
- **[`Nebius.kms.AsymmetricKey`](RESOURCES.md#nebiuskmsasymmetrickey)** — ECDSA and RSA signing/encryption keys

### Secrets (MysteryBox)

- **[`Nebius.mysterybox.Secret`](RESOURCES.md#nebiusmysteryboxsecret)** — Versioned secret storage with KMS encryption and inline payloads
- **[`Nebius.mysterybox.SecretVersion`](RESOURCES.md#nebiusmysteryboxsecretversion)** — Secret versions with primary-version promotion. The service has no `Update` RPC, so `description`, `payload` and `setPrimary` are immutable: a change replaces the version, delete-first (the physical name is `sv-<logicalId>` on every generation). `name` is the version's immutable `metadata.name` and defaults to `sv-<logicalId>`

### Quotas

- **[`Nebius.quotas.QuotaAllowance`](RESOURCES.md#nebiusquotasquotaallowance)** — Project quota management by region

### Discovery Actions

[Alchemy actions](https://alchemy.run/infrastructure-as-code/action/) for discovering existing resources without adopting them. Useful in `alchemy plan` for auditing.

- `Nebius.iam.action.ListProjects` / `GetProject`
- `Nebius.iam.action.ListGroups` / `GetGroup`
- `Nebius.vpc.action.ListNetworks` / `GetNetwork`
- `Nebius.vpc.action.ListSubnets` / `GetSubnet`
- `Nebius.vpc.action.ListRouteTables` / `GetRouteTable`
- `Nebius.quotas.action.ListQuotas` / `GetQuota`
- `Nebius.capacity.action.ListResourceAdvice` — read-only capacity advice per `(region, fabric, platform, preset)`, with availability split by capacity class (reserved / on-demand / preemptible) and your quota limit. **It is the in-API source of InfiniBand fabric ids**, which `Nebius.compute.GpuCluster`'s required `infinibandFabric` prop needs. The advisor is `list`-only and tenant-scoped; filters (`region` / `platform` / `preset`) are applied client-side:
- `Nebius.mk8s.action.ListClusterControlPlaneVersions` — the cluster version catalogue (`<major>.<minor>`, plus `restricted`, `deprecated` and `endOfLife`). The authority behind `Cluster.version`/`NodeGroup.version`, and the way to avoid pinning a version that is about to go deprecated
- `Nebius.mk8s.action.GetNodeGroupCompatibilityMatrix` — `{ clusterKubernetesVersion, platform }` → the `os` + `driversPreset` pairs that combination supports. The authority behind `NodeGroup.template.os`; a live query, never a local constant

```ts
const rows = yield * Nebius.capacity.action.ListResourceAdvice({ region: 'eu-north1', platform: 'gpu-h200-sxm' })
// Not every row is fabric-scoped — filter out the empty ones.
const fabrics = [...new Set(rows.map((row) => row.fabric).filter((fabric) => fabric !== ''))]
const room = rows.find((row) => row.fabric === fabrics[0])?.onDemand?.available ?? 0
```

- `Nebius.capacity.action.ListCapacityBlockGroups` / `GetCapacityBlockGroup` / `GetCapacityBlockGroupByResourceAffinity` — the **reserved-capacity** family, and the source of the `CapacityBlockGroupId`s that `Instance.reservationPolicy.reservationIds` takes (in priority order). `GetCapacityBlockGroupByResourceAffinity({ region, fabric, platform })` is the lookup that turns an advice row above into a reservation. Read-only: a block group is allocated by the platform (`CapacityBlockGroupSpec` is an empty message and the service exposes no create/update/delete). ⚠️ **This tenant holds none**, so an empty list is expected here and the live test asserts that rather than a row. `GetCapacityBlockGroup`'s miss names the id (`Capacity Block Group (id=…) not found`); the affinity form names the whole `(region, fabric, platform)` it searched
- `Nebius.capacity.action.ListCapacityIntervals` — the schedule behind a block group (which windows reserve how much). Parent is a **Capacity Block Group**, not a tenant: the API rejects a tenant with `parent_id: Value error, Expected capacityblockgroup type but got tenant`
- `Nebius.capacity.action.ListCapacityAllowances` — the per-project quota limit on a block group (`limit: undefined` means **unlimited**, which is not the same as `0`). ⚠️ The API's `List` also returns _non-created_ rows, so a row does **not** mean your stack created it — compare against the default instead of treating presence as ownership

## Bindings

**Bindings** are typed runtime clients you attach to **your own compute host** — a **Nebius Instance by default**, or a Cloudflare Worker (`Cloudflare.Worker` is the compatibility wrapper). One declaration derives three things at deploy time:

1. **Credential minting + least-privilege grant** on Nebius — a per-host service account holding an S3 access key, placed in its own `<host>BindingGroup` (not the tenant's `editors` group), plus one **bucket-scoped** `iam.AccessPermit` per capability: `storage.viewer` for reads, `storage.editor` for writes. No project-wide role is granted,
2. **env injection** into the host's runtime env — `plain_text`/`secret_text` bindings on a Worker, the shipped `EnvironmentFile` on an Instance,
3. a **typed runtime client** (s3-lite-client, fetch-based) reading those env values.

```ts
// alchemy.run.ts — the Nebius Instance is its own binding host.

import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

const bucket = yield * Nebius.storage.Bucket('Assets')

yield *
  Nebius.compute.Instance(
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

`program.ts` is what actually runs on the VM. It _consumes_ the binding — the
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
readiness and the first _call_ with an empty URL fails with
`EndpointNotRunning`. See [AI_BINDINGS.md](AI_BINDINGS.md) for the design
and [`examples/ai.bindings.ts`](examples/ai.bindings.ts) for a full example.

### Bindings env reference

Injected into the host's runtime env at deploy time (names are stable). Secrets
are Cloudflare `secret_text` bindings on a Worker, and plaintext in the
`EnvironmentFile` on an Instance host:

| Env var                      | Meaning                                               |
| ---------------------------- | ----------------------------------------------------- |
| `NEBIUS_S3_ENDPOINT`         | `https://storage.<region>.nebius.cloud`               |
| `NEBIUS_REGION`              | Region the access key was minted in                   |
| `NEBIUS_ACCESS_KEY_ID`       | AWS-style access key id (plain text)                  |
| `NEBIUS_SECRET_ACCESS_KEY`   | Secret access key (`secret_text` on a Worker)         |
| `NEBIUS_BUCKET_NAME`         | The bound bucket's name                               |
| `NEBIUS_ENDPOINT_URL`        | The endpoint's first public URL (AI bindings)         |
| `NEBIUS_ENDPOINT_AUTH_TOKEN` | The endpoint's bearer token (`''` when auth disabled) |

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
> Cloudflare `{ bindings: [...] }` payload against a _mock_ host — there is no
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
