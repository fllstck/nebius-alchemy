# Example Stacks

Deployable [Alchemy](https://alchemy.run) stacks that provision real Nebius resources. Each file is a complete stack — copy one, or just deploy it directly.

Environment variables are read from `.env` (see [`.env.example`](.env.example)):

| Variable            | Required        | Description                                          |
| ------------------- | --------------- | ---------------------------------------------------- |
| `NEBIUS_API_KEY`    | yes             | Auto-populated from the Nebius CLI (or set manually) |
| `NEBIUS_PROJECT_ID` | yes             | Target project                                       |
| `NEBIUS_TENANT_ID`  | for some stacks | Needed by the actions example and Worker bindings    |
| `NEBIUS_REGION`     | no              | Defaults to `eu-north1`                              |

> ⚠️ These stacks create real, billable resources in your Nebius project. Always run `alchemy destroy --yes` when you're done.

## Core Resources

### [storage.ts](storage.ts) — Object Storage bucket

The minimal starting point: creates a single Nebius Bucket and returns its id, name, and state. Demonstrates the simplest possible `Alchemy.Stack` with auto-generated names.

### [vpc.ts](vpc.ts) — Full VPC topology

Creates a complete networking stack: Network, Subnet, RouteTable, Route (default egress gateway), SecurityGroup, SecurityRule (stateful, TCP 80/443 ingress), IP Pool, and Allocation. All names are omitted from props and auto-generated from logical IDs.

### [dns.ts](dns.ts) — DNS zone and record

Creates a VPC network (as zone scope), a VPC-scoped DNS zone for `alchemy-demo-test.com.`, and an `A` record at the zone apex (`@`) pointing to `192.0.2.1`.

### [iam.ts](iam.ts) — Service account and static key

Creates a ServiceAccount and a StaticKey (CONTAINER_REGISTRY service) for programmatic access. Demonstrates the non-standard `Issue` lifecycle: the static key token is only available at creation time and is stored in Alchemy state.

### [kms.ts](kms.ts) — KMS keys

Creates both KMS key types: a SymmetricKey (AES_256) and an AsymmetricKey (ECDSA_NIST_P256_SHA_256), each with auto-generated names.

### [mysterybox.ts](mysterybox.ts) — Secrets and versions

Creates a Secret with an initial version and payload, then adds a second version (`v2`) with updated credentials and `setPrimary: true` to promote it as primary.

### [compute.ts](compute.ts) — Image → Disk → Instance

Dynamically looks up the latest Ubuntu 22.04 LTS image by family, creates a NETWORK_SSD boot disk from it, and launches a preemptible instance (`gpu-h200-sxm`) using that disk. Requires `SUBNET_ID` and `SERVICE_ACCOUNT_ID`; `IMAGE_FAMILY` and `DISK_SIZE_GB` are optional.

### [mk8s.ts](mk8s.ts) — Managed Kubernetes cluster + one worker node

Creates a working control plane and a real worker node: network → subnet → cluster, plus a service account with an `editor` grant (group → permit → membership) whose id the node template needs for registry pulls and API access, then a `cpu-d3` node group with a 64 GiB boot disk and cloud-init user-data. It is the example that shows the non-obvious parts: the parent is the **cluster** (no project fallback), `fixedNodeCount` and `autoscaling` are mutually exclusive and one is required, `os`/`driversPreset` come from `Nebius.mk8s.action.GetNodeGroupCompatibilityMatrix` rather than a local list, and `etcdClusterSize: 1` keeps the demo cheap (non-HA). The commented block in the node template lists the optional surface — `strategy`, `autoRepair`, node/instance labels, taints, `maxPods`, `preemptible`, filesystems, capacity reservations, GPU and NVLink — with the caveats for each. **⚠️ Provisions a real billable VM** and is the slowest stack here (a node group takes minutes to `RUNNING` and its delete waits for the VM).

## Discovery Actions

### [actions.ts](actions.ts) — Read-only list/get actions

Demonstrates the read-only discovery actions: list-all and single-get for IAM projects/groups, VPC networks/subnets/route tables, and quotas. No state is created — each action is a pure read visible in `alchemy plan`. Requires `NEBIUS_TENANT_ID`.

## Cloudflare Worker Bindings

The bindings examples ship typed Nebius S3 clients to a Cloudflare Worker at deploy time (host identity mint, editors-group grant, access key, and `NEBIUS_S3_*` env injection). Each has a stack file plus a separate Worker entry file — keeping the entry out of the stack keeps the deployed bundle free of provider/runtime machinery.

### [storage.bindings.ts](storage.bindings.ts) — Effect-native Worker (inline form)

The Worker entry ([storage.bindings-worker.ts](storage.bindings-worker.ts)) is a `Cloudflare.Worker` with an inline `Effect.gen` implementation. It declares the bucket, consumes the typed `GetObject`/`PutObject` runtime clients, and exposes a `GET`/`POST` HTTP API. Uses narrow deep-subpath imports so rolldown can tree-shake the handler bundle. Requires a Cloudflare API token or `alchemy profile edit --add Cloudflare`.

### [storage-async.bindings.ts](storage-async.bindings.ts) — Async Worker (tiny bundle)

Same deploy-time wiring as `storage.bindings.ts`, but the Worker entry ([storage-async.bindings-worker.ts](storage-async.bindings-worker.ts)) is a plain async function with no Effect runtime — it reads `env` and drives s3-lite-client directly. Deployed size is a fraction of the Effect-native variant (~50–150 KB vs ~2 MB). The trade: you lose the typed `GetObject`/`PutObject` contracts inside the worker.

### [ai.bindings.ts](ai.bindings.ts) — AI endpoint ChatCompletions

The Worker entry ([ai.bindings-worker.ts](ai.bindings-worker.ts)) declares an inference endpoint (network + subnet + the official vLLM Qwen3-0.6B config from the Nebius Serverless AI cookbook — L40S GPU) and consumes the typed `ChatCompletions` runtime client: deploy-time `NEBIUS_ENDPOINT_URL`/`NEBIUS_ENDPOINT_AUTH_TOKEN` injection (the token deploys as a Cloudflare secret), a fetch-based OpenAI-compatible client at runtime. Auth is a bearer token — unlike the S3 bindings there is no identity minting or IAM grant. The provider awaits the endpoint to RUNNING before wiring the URL (progress notes included); a broken endpoint fails with `EndpointNotReady`. See [AI_BINDINGS.md](../AI_BINDINGS.md) for the design.

## Coverage — what is *not* demonstrated, and why

Every resource is checkable against this list by name; the ones absent from the files above are absent
**on purpose** or **not yet written**, and the difference matters:

| resource | status |
| `Nebius.iam.Invitation` | **deliberately not demonstrated.** Creating one sends real email to a real person (the same reason the live-echo audit excludes it) — an example is one `alchemy deploy` away from being run by accident |
| `Nebius.quotas.QuotaAllowance` | **deliberately not demonstrated.** It mutates the tenant's real quotas, and its identity is the `(parent, name, region)` tuple because the service has no stable `id` |
| `Nebius.iam.Federation` / `FederationCertificate` | **deliberately not demonstrated.** Tenant-scoped SSO configuration: it needs tenant-admin rights and points at a real identity provider's metadata/certificate, none of which a project-scoped example can supply |
| `Nebius.iam.Project` | **deliberately not demonstrated.** The one resource here that is not project-scoped — a stack would create a whole new project (and its billing/entitlement context) rather than something inside the current one |
| `Nebius.ai.Job` | **not demonstrated.** The low-level compute job behind `ai.Endpoint`; it needs GPU quota and runs for minutes, and [ai.bindings.ts](ai.bindings.ts) already covers the AI path end to end |
| `Nebius.compute.GpuCluster` / `NVLInstanceGroup` | **commented, not runnable.** The snippet lives in [compute.ts](compute.ts) (fabric discovery → group → instance membership); deploying `NVLInstanceGroup` needs the `GB200`/`GB300` entitlement, so it stays a snippet rather than a stack that would fail on quota |
| `Nebius.storage.Transfer` | **not yet written.** Genuine gap: two buckets, an access key and a stop condition — the only `storage` resource without a file |
| `Nebius.iam.AccessKey` (v2) | **not yet written.** The standalone S3 credential pair (the bindings examples mint one internally); an example would have to be explicit that it returns a secret |
| `Nebius.compute.Filesystem` / `DiskSnapshot` | **not yet written.** Cheap to add, and `Filesystem` is what the commented `template.filesystems` line in [mk8s.ts](mk8s.ts) points at |
| `Nebius.iam.AuthPublicKey` / `FederatedCredentials` | **not yet written.** Niche credential flows (a pinned RSA-4096 public key; OIDC federation for CI) that need a PEM or an IdP's issuer/subject pair as input |

## Companion Files

- [.env.example](.env.example) — optional default tenant/project IDs for the examples
