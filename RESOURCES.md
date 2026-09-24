# Resources — API reference

Every implemented resource, with its props (required vs optional), the **type** of each prop as the schema
declares it, and the **plan-time validations** — the rules that fail `alchemy plan` (or the plan's props
validation) instead of an apply. Generated from the schemas by
[`tools/generate-resources-doc.ts`](tools/generate-resources-doc.ts): `bun run docs:resources`, and
`tests/resources-doc.test.ts` fails when this file is stale.

The **documented default** column is lifted from each prop's own doc comment, which is where this repo
records defaults. A dash means *no default is documented at that prop* — not that there is none: three
kinds are out of its reach and are named here once. (1) The provider's own fallbacks: `parentId` defaults
to `NEBIUS_PROJECT_ID` where the resource is project-scoped, optional `name` to a generated physical name,
`os`/`resources.preset` on a node group to the platform's compatibility matrix. (2) Request-only fields
(`invitation.{noSend,expiresInSeconds}`). (3) Values the platform decides and does not document, where the
prop says so instead.

The narrative for each resource — what it is for, what is measured against real infra, and the API traps —
is in [README.md § Resources](README.md#resources); each heading below links back to it.

41 resources.

## Index

- [`Nebius.ai.Endpoint`](#nebiusaiendpoint)
- [`Nebius.ai.Job`](#nebiusaijob)
- [`Nebius.billing.PricingPolicy`](#nebiusbillingpricingpolicy)
- [`Nebius.compute.Disk`](#nebiuscomputedisk)
- [`Nebius.compute.DiskSnapshot`](#nebiuscomputedisksnapshot)
- [`Nebius.compute.Filesystem`](#nebiuscomputefilesystem)
- [`Nebius.compute.GpuCluster`](#nebiuscomputegpucluster)
- [`Nebius.compute.Image`](#nebiuscomputeimage)
- [`Nebius.compute.Instance`](#nebiuscomputeinstance)
- [`Nebius.compute.NVLInstanceGroup`](#nebiuscomputenvlinstancegroup)
- [`Nebius.dns.Record`](#nebiusdnsrecord)
- [`Nebius.dns.Zone`](#nebiusdnszone)
- [`Nebius.iam.AccessKey`](#nebiusiamaccesskey)
- [`Nebius.iam.AccessPermit`](#nebiusiamaccesspermit)
- [`Nebius.iam.AuthPublicKey`](#nebiusiamauthpublickey)
- [`Nebius.iam.FederatedCredentials`](#nebiusiamfederatedcredentials)
- [`Nebius.iam.Federation`](#nebiusiamfederation)
- [`Nebius.iam.FederationCertificate`](#nebiusiamfederationcertificate)
- [`Nebius.iam.Group`](#nebiusiamgroup)
- [`Nebius.iam.GroupMembership`](#nebiusiamgroupmembership)
- [`Nebius.iam.Invitation`](#nebiusiaminvitation)
- [`Nebius.iam.Project`](#nebiusiamproject)
- [`Nebius.iam.ServiceAccount`](#nebiusiamserviceaccount)
- [`Nebius.iam.StaticKey`](#nebiusiamstatickey)
- [`Nebius.kms.AsymmetricKey`](#nebiuskmsasymmetrickey)
- [`Nebius.kms.SymmetricKey`](#nebiuskmssymmetrickey)
- [`Nebius.mk8s.Cluster`](#nebiusmk8scluster)
- [`Nebius.mk8s.NodeGroup`](#nebiusmk8snodegroup)
- [`Nebius.mysterybox.Secret`](#nebiusmysteryboxsecret)
- [`Nebius.mysterybox.SecretVersion`](#nebiusmysteryboxsecretversion)
- [`Nebius.quotas.QuotaAllowance`](#nebiusquotasquotaallowance)
- [`Nebius.storage.Bucket`](#nebiusstoragebucket)
- [`Nebius.storage.Transfer`](#nebiusstoragetransfer)
- [`Nebius.vpc.Allocation`](#nebiusvpcallocation)
- [`Nebius.vpc.Network`](#nebiusvpcnetwork)
- [`Nebius.vpc.Pool`](#nebiusvpcpool)
- [`Nebius.vpc.Route`](#nebiusvpcroute)
- [`Nebius.vpc.RouteTable`](#nebiusvpcroutetable)
- [`Nebius.vpc.SecurityGroup`](#nebiusvpcsecuritygroup)
- [`Nebius.vpc.SecurityRule`](#nebiusvpcsecurityrule)
- [`Nebius.vpc.Subnet`](#nebiusvpcsubnet)

## `Nebius.ai.Endpoint`

*Defined in [`modules/resources/ai/v1/endpoint.ts`](modules/resources/ai/v1/endpoint.ts). Narrative and live-verification status: [README.md § AI](README.md#ai).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `disk` | **yes** | `JobSchema.JobDiskSchema` | — | — |
| `environmentVariables` | **yes** | `Schema.Array(JobSchema.EnvironmentVariableSchema)` | — | — |
| `image` | **yes** | `Schema.String` | — | — |
| `platform` | **yes** | `Schema.String` | — | — |
| `ports` | **yes** | `Schema.Array(JobSchema.PortSchema)` | — | — |
| `preemptible` | **yes** | `Schema.Boolean` | — | — |
| `preset` | **yes** | `Schema.String` | — | — |
| `publicIp` | **yes** | `Schema.Boolean` | — | — |
| `subnetId` | **yes** | `VpcIds.SubnetId` | — | — |
| `volumes` | **yes** | `Schema.Array(JobSchema.VolumeMountSchema)` | — | — |
| `args` | no | `Schema.String` | — | — |
| `authToken` | no | `Schema.String` | — | — |
| `authTokenMysteryboxSecret` | no | `JobSchema.MysteryBoxSecretRefSchema` | — | — |
| `containerCommand` | no | `Schema.String` | — | — |
| `injectedFiles` | no | `Schema.Array(JobSchema.FileInjectionSchema)` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `pricing` | no | `PricingModelSchema` | — | — |
| `registryCredentials` | no | `JobSchema.RegistryCredentialsSchema` | — | — |
| `shmSizeBytes` | no | `Schema.Finite` | — | — |
| `sshAuthorizedKeys` | no | `Schema.Array(Schema.String)` | — | — |
| `workingDir` | no | `Schema.String` | — | — |

Resource-level validations (they compare several props, so they are not attached to one row): `authTokenValid`, `pricingMatchesBooleanPreemptible`.

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.EndpointId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `privateEndpoints` | **yes** | `Schema.Array(Schema.String)` | — |
| `publicEndpoints` | **yes** | `Schema.Array(Schema.String)` | — |
| `state` | **yes** | `Schema.Union([ Schema.Literal('PROVISIONING'), Schema.Literal('STARTING'), Schema.Literal('RUNNING'), Schema.Literal('STOPPING'), Schema.Literal('DELETING'), Schema.Literal('STOPPED'), Schema.Literal('ERROR'), Schema.Literal('IMAGE_PULLING'), ])` | — |
| `authToken` | no | `Schema.String` | The endpoint's bearer auth token. |

---

## `Nebius.ai.Job`

*Defined in [`modules/resources/ai/v1/job.ts`](modules/resources/ai/v1/job.ts). Narrative and live-verification status: [README.md § AI](README.md#ai).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `disk` | **yes** | `JobDiskSchema` | — | — |
| `disk.sizeBytes` | **yes** | `Schema.Finite` | — | `diskSizeValid` |
| `disk.type` | **yes** | `DiskTypeSchema` | — | — |
| `environmentVariables` | **yes** | `Schema.Array(EnvironmentVariableSchema)` | — | — |
| `image` | **yes** | `Schema.String` | — | — |
| `platform` | **yes** | `Schema.String` | — | — |
| `ports` | **yes** | `Schema.Array(PortSchema)` | — | — |
| `preemptible` | **yes** | `Schema.Boolean` | — | — |
| `preset` | **yes** | `Schema.String` | — | — |
| `publicIp` | **yes** | `Schema.Boolean` | — | — |
| `subnetId` | **yes** | `VpcIds.SubnetId` | — | — |
| `volumes` | **yes** | `Schema.Array(VolumeMountSchema)` | — | — |
| `args` | no | `Schema.String` | — | — |
| `containerCommand` | no | `Schema.String` | — | — |
| `injectedFiles` | no | `Schema.Array(FileInjectionSchema)` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `pricing` | no | `PricingModelSchema` | — | — |
| `registryCredentials` | no | `RegistryCredentialsSchema` | — | — |
| `restartAttempts` | no | `Schema.Finite` | — | — |
| `shmSizeBytes` | no | `Schema.Finite` | — | — |
| `sshAuthorizedKeys` | no | `Schema.Array(Schema.String)` | — | — |
| `timeout` | no | `{ … }` | — | — |
| `timeout.seconds` | **yes** | `Schema.Finite` | — | — |
| `timeout.nanos` | no | `Schema.Finite` | — | — |
| `workingDir` | no | `Schema.String` | — | — |

Resource-level validations (they compare several props, so they are not attached to one row): `pricingMatchesBooleanPreemptible`.

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.JobId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([ Schema.Literal('PROVISIONING'), Schema.Literal('STARTING'), Schema.Literal('RUNNING'), Schema.Literal('CANCELLING'), Schema.Literal('DELETING'), Schema.Literal('COMPLETED'), Schema.Literal('FAILED'), Schema.Literal('CANCELLED'), Schema.Literal('ERROR'), Schema.Literal('IMAGE_PULLING'), ])` | — |
| `finishedAt` | no | `Schema.String` | — |
| `startedAt` | no | `Schema.String` | — |

---

## `Nebius.billing.PricingPolicy`

*Defined in [`modules/resources/billing/v1/pricing-policy.ts`](modules/resources/billing/v1/pricing-policy.ts). Narrative and live-verification status: [README.md § Upgrading from 0.9.x](README.md#upgrading-from-09x).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `maxPrice` | **yes** | `Schema.String` | — | `priceValid` |
| `platform` | **yes** | `Schema.String` | — | `isNonEmptyString('platform')` |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.PricingPolicyId` | — |
| `maxPrice` | **yes** | `Schema.String` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `platform` | **yes** | `Schema.String` | — |
| `currency` | no | `Schema.String` | ISO 4217 code as the API spells it — measured live 2026-09-24 as lowercase `"usd"`. |
| `runningVmCount` | no | `Schema.String` | VMs currently running under this policy. |
| `schedulingState` | no | `Schema.String` | Whether new VMs may currently start under this policy. |
| `skuId` | no | `Schema.String` | The SKU the platform resolved from `platform`. |
| `state` | no | `Schema.String` | `CREATING` / `ACTIVE` / `DELETING` / `UPDATING` (the last while a bid change lands). |

---

## `Nebius.compute.Disk`

*Defined in [`modules/resources/compute/v1/disk.ts`](modules/resources/compute/v1/disk.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `type` | **yes** | `DiskTypeSchema` | — | — |
| `blockSizeBytes` | no | `Schema.Finite` | 4096 | — |
| `diskEncryption` | no | `DiskEncryptionSchema` | — | — |
| `diskEncryption.type` | **yes** | `Schema.Union([ Schema.Literal('DISK_ENCRYPTION_UNSPECIFIED'), Schema.Literal('DISK_ENCRYPTION_MANAGED'), ])` | — | — |
| `forbidDeletion` | no | `Schema.Boolean` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `sizeGibibytes` | no | `Schema.Finite` | — | — |
| `sourceImageFamily` | no | `SourceImageFamilySchema` | — | — |
| `sourceImageFamily.imageFamily` | **yes** | `Schema.String` | — | — |
| `sourceImageFamily.parentId` | no | `IamV2Ids.ProjectId` | the region's public-images parent | — |
| `sourceImageId` | no | `Ids.ImageId` | — | — |
| `sourceSnapshotId` | no | `Ids.DiskSnapshotId` | — | — |

Resource-level validations (they compare several props, so they are not attached to one row): `atMostOneDiskSource`.

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.DiskId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([ Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('UPDATING'), Schema.Literal('DELETING'), Schema.Literal('ERROR'), Schema.Literal('BROKEN'), ])` | — |
| `type` | **yes** | `DiskTypeSchema` | — |
| `blockSizeBytes` | no | `Schema.String` | Block size in bytes. |
| `readWriteAttachment` | no | `Schema.String` | Instance ID that has read-write attachment to this disk. |
| `sizeGibibytes` | no | `Schema.String` | Size in gibibytes, as the platform reports it. |
| `sourceImageId` | no | `Ids.ImageId` | — |

---

## `Nebius.compute.DiskSnapshot`

*Defined in [`modules/resources/compute/v1/disk-snapshot.ts`](modules/resources/compute/v1/disk-snapshot.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `sourceDiskId` | **yes** | `Ids.DiskId` | — | — |
| `description` | no | `Schema.String` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | — |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `contentSizeBytes` | **yes** | `Schema.String` | Size of the snapshot content in bytes. |
| `description` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.DiskSnapshotId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `sourceDiskId` | **yes** | `Ids.DiskId` | — |
| `state` | **yes** | `Schema.String` | — |
| `storageSizeBytes` | **yes** | `Schema.String` | Storage actually consumed in bytes. |
| `sourceCpuArchitecture` | no | `Schema.String` | — |

---

## `Nebius.compute.Filesystem`

*Defined in [`modules/resources/compute/v1/filesystem.ts`](modules/resources/compute/v1/filesystem.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `sizeGibibytes` | **yes** | `Schema.Finite` | — | — |
| `type` | **yes** | `FilesystemTypeSchema` | — | — |
| `blockSizeBytes` | no | `Schema.Finite` | 4096 | `isValidBlockSize` |
| `forbidDeletion` | no | `Schema.Boolean` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.FilesystemId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `sizeGibibytes` | **yes** | `Schema.String` | Size in gibibytes, as the platform reports it. |
| `state` | **yes** | `Schema.String` | — |
| `type` | **yes** | `Schema.String` | — |
| `blockSizeBytes` | no | `Schema.String` | Block size in bytes. |
| `forbidDeletion` | no | `Schema.Boolean` | — |
| `reconciling` | no | `Schema.Boolean` | — |
| `stateDescription` | no | `Schema.String` | — |

---

## `Nebius.compute.GpuCluster`

*Defined in [`modules/resources/compute/v1/gpu-cluster.ts`](modules/resources/compute/v1/gpu-cluster.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `infinibandFabric` | **yes** | `Schema.String` | — | `fabricValid` |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.GpuClusterId` | — |
| `infinibandFabric` | **yes** | `Schema.String` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `infinibandTopologyPath` | no | `{ … }` | InfiniBand topology path per attached instance, when the platform reports it. |
| `instances` | no | `Schema.Array(Ids.InstanceId)` | Instances currently attached (read-only). |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — |
| `reconciling` | no | `Schema.Boolean` | Whether an operation is in flight on the cluster. |

---

## `Nebius.compute.Image`

*Defined in [`modules/resources/compute/v1/image.ts`](modules/resources/compute/v1/image.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `cpuArchitecture` | no | `CPUArchitectureSchema` | AMD64 | — |
| `description` | no | `Schema.String` | — | — |
| `imageFamily` | no | `Schema.String` | — | — |
| `imageFamilyHumanReadable` | no | `Schema.String` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `recommendedPlatforms` | no | `Schema.Array(Schema.String)` | — | — |
| `sourceDiskId` | no | `Ids.DiskId` | — | — |
| `sourceDiskSnapshotId` | no | `Ids.DiskSnapshotId` | — | — |
| `sourceStorage` | no | `SourceStorageSchema` | — | — |
| `sourceStorage.bucketName` | **yes** | `Schema.String` | — | — |
| `sourceStorage.objectName` | **yes** | `Schema.String` | — | — |
| `version` | no | `Schema.String` | — | — |

Resource-level validations (they compare several props, so they are not attached to one row): `exactlyOneImageSource`.

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.ImageId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([ Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('UPDATING'), Schema.Literal('DELETING'), Schema.Literal('ERROR'), ])` | — |
| `description` | no | `Schema.String` | — |
| `imageFamily` | no | `Schema.String` | — |
| `minDiskSizeBytes` | no | `Schema.String` | — |
| `storageSizeBytes` | no | `Schema.String` | — |

---

## `Nebius.compute.Instance`

*Defined in [`modules/resources/compute/v1/instance.ts`](modules/resources/compute/v1/instance.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `bootDisk` | **yes** | `AttachedDiskSpecSchema` | — | — |
| `bootDisk.attachMode` | **yes** | `AttachModeSchema` | — | — |
| `bootDisk.deviceId` | no | `Schema.String` | — | — |
| `bootDisk.existingDisk` | no | `ExistingDiskSchema` | — | — |
| `bootDisk.managedDisk` | no | `ManagedDiskSchema` | — | — |
| `networkInterfaces` | **yes** | `Schema.Array(NetworkInterfaceSpecSchema)` | — | — |
| `resources` | **yes** | `ResourcesSpecSchema` | — | — |
| `resources.platform` | **yes** | `PlatformSchema` | — | — |
| `resources.preset` | no | `PresetSchema` | — | — |
| `serviceAccountId` | **yes** | `InstanceServiceAccountId` | — | — |
| `bucket` | no | `Schema.String` | provider-declared bucket keyed on the stack id | — |
| `build` | no | `BundleConfigSchema` | — | — |
| `cloudInitUserData` | no | `Schema.String` | — | — |
| `env` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `filesystems` | no | `Schema.Array(AttachedFilesystemSpecSchema)` | — | — |
| `gpuCluster` | no | `{ … }` | — | — |
| `gpuCluster.id` | **yes** | `Ids.GpuClusterId` | — | — |
| `handler` | no | `Schema.String` | "default" | — |
| `hosted` | no | `Schema.Unknown` | — | — |
| `hostname` | no | `Schema.String` | — | — |
| `isExternal` | no | `Schema.Boolean` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `localDisks` | no | `LocalDisksSpecSchema` | — | — |
| `localDisks.passthroughGroup` | **yes** | `{ … }` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `nvlInstanceGroupId` | no | `Ids.NVLInstanceGroupId` | — | — |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `port` | no | `Schema.Finite` | 3000 | `isValidPort` |
| `preemptible` | no | `PreemptibleSchema` | — | — |
| `preemptible.onPreemption` | **yes** | `Schema.Literal('STOP')` | — | — |
| `pricing` | no | `PricingModelSchema` | — | — |
| `recoveryPolicy` | no | `RecoveryPolicySchema` | RECOVER | — |
| `reservationPolicy` | no | `ReservationPolicySchema` | — | — |
| `reservationPolicy.policy` | **yes** | `Schema.Union([Schema.Literal('AUTO'), Schema.Literal('FORBID'), Schema.Literal('STRICT')])` | — | — |
| `reservationPolicy.reservationIds` | **yes** | `Schema.Array(CapacityIds.CapacityBlockGroupId)` | — | — |
| `secondaryDisks` | no | `Schema.Array(AttachedDiskSpecSchema)` | — | — |
| `stopped` | no | `Schema.Boolean` | — | — |

Resource-level validations (they compare several props, so they are not attached to one row): `bootDiskImageRequired`, `pricingMatchesPresenceOnlyPreemptible`.

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.InstanceId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `serviceAccountId` | **yes** | `InstanceServiceAccountId` | — |
| `state` | **yes** | `Schema.Union([ Schema.Literal('CREATING'), Schema.Literal('UPDATING'), Schema.Literal('STARTING'), Schema.Literal('RUNNING'), Schema.Literal('STOPPING'), Schema.Literal('STOPPED'), Schema.Literal('DELETING'), Schema.Literal('ERROR'), ])` | — |
| `assetPrefix` | no | `Schema.String` | Asset prefix for hosted bundles and env files. |
| `code` | no | `{ … }` | Bundle hash for hosted instances — what the VM is currently running. |
| `hostedAccessKeyId` | no | `Schema.String` | value* (`identity.awsAccessKeyId`), not the `AccessKey` resource ID. |
| `hostedRegion` | no | `Schema.String` |  |
| `hostedSecretAccessKey` | no | `Schema.String` |  |
| `runtimeUnitName` | no | `Schema.String` | Deterministic runtime unit name for hosted instances. |

---

## `Nebius.compute.NVLInstanceGroup`

*Defined in [`modules/resources/compute/v1/nvl-instance-group.ts`](modules/resources/compute/v1/nvl-instance-group.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `size` | **yes** | `Schema.Finite` | — | `sizeValid` |
| `type` | **yes** | `NVLInstanceGroupTypeSchema` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.NVLInstanceGroupId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `size` | **yes** | `Schema.String` | int64 on the wire, so the JSON form is a decimal string (see `toFriendlyAttributes`). |
| `type` | **yes** | `Schema.String` | Enum name from the schema (e.g. |
| `instances` | no | `Schema.Record(Schema.String, { … })` | Attached instances keyed by instance ID, each with its current state (read-only). |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — |
| `reconciling` | no | `Schema.Boolean` | Whether an operation is in flight on the group. |

---

## `Nebius.dns.Record`

*Defined in [`modules/resources/dns/v1/record.ts`](modules/resources/dns/v1/record.ts). Narrative and live-verification status: [README.md § DNS](README.md#dns).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `data` | **yes** | `Schema.String` | — | — |
| `parentId` | **yes** | `Ids.ZoneId` | — | — |
| `relativeName` | **yes** | `Schema.String` | — | — |
| `type` | **yes** | `RecordTypeSchema` | — | — |
| `deletionProtection` | no | `Schema.Boolean` | — | — |
| `ttl` | no | `Schema.Finite` | 600 | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `data` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.RecordId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `Ids.ZoneId` | — |
| `type` | **yes** | `RecordTypeSchema` | — |
| `effectiveFqdn` | no | `Schema.String` | — |
| `relativeName` | no | `Schema.String` | — |
| `ttl` | no | `Schema.String` | — |

---

## `Nebius.dns.Zone`

*Defined in [`modules/resources/dns/v1/zone.ts`](modules/resources/dns/v1/zone.ts). Narrative and live-verification status: [README.md § DNS](README.md#dns).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `domainName` | **yes** | `Schema.String` | — | — |
| `vpc` | **yes** | `VpcZoneScopeSchema` | — | — |
| `vpc.primaryNetworkId` | **yes** | `VpcIds.NetworkId` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `soaSpec` | no | `SoaSpecSchema` | the platform's SOA defaults | — |
| `soaSpec.negativeTtl` | no | `Schema.Finite` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `domainName` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.ZoneId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Literal('READY')` | — |
| `recordCount` | no | `Schema.String` | — |

---

## `Nebius.iam.AccessKey`

*Defined in [`modules/resources/iam/v2/access-key.ts`](modules/resources/iam/v2/access-key.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `serviceAccountId` | **yes** | `IamIds.ServiceAccountId` | — | — |
| `description` | no | `Schema.String` | — | — |
| `expiresAt` | no | `Schema.DateFromString` | — | — |
| `secretDeliveryMode` | no | `SecretDeliveryMode` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `algorithm` | **yes** | `Schema.String` | — |
| `awsAccessKeyId` | **yes** | `Schema.String` | The AWS-compatible access key ID (e.g. |
| `description` | **yes** | `Schema.String` | — |
| `fingerprint` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.AccessKeyId` | — |
| `keySize` | **yes** | `Schema.Finite` | — |
| `secretAccessKey` | **yes** | `Schema.String` | The secret access key. |
| `secretDeliveryMode` | **yes** | `SecretDeliveryMode` | — |
| `serviceAccountId` | **yes** | `IamIds.ServiceAccountId` | — |
| `state` | **yes** | `Schema.String` | — |
| `createdAt` | no | `Schema.DateFromString` | — |
| `expiresAt` | no | `Schema.DateFromString` | — |
| `secretReferenceId` | no | `MysteryboxIds.SecretId` | When MYSTERY_BOX delivery is used, references the MysteryBox secret containing the actual key material. |

---

## `Nebius.iam.AccessPermit`

*Defined in [`modules/resources/iam/v1/access-permit.ts`](modules/resources/iam/v1/access-permit.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `parentId` | **yes** | `Ids.GroupId` | — | — |
| `resourceId` | **yes** | `Ids.AccessPermitResourceId` | — | — |
| `role` | **yes** | `Schema.String` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.AccessPermitId` | — |
| `parentId` | **yes** | `Ids.GroupId` | — |
| `resourceId` | **yes** | `Ids.AccessPermitResourceId` | — |
| `role` | **yes** | `Schema.String` | — |
| `name` | no | `Schema.String` | — |

---

## `Nebius.iam.AuthPublicKey`

*Defined in [`modules/resources/iam/v1/auth-public-key.ts`](modules/resources/iam/v1/auth-public-key.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `accountId` | **yes** | `Ids.ServiceAccountId` | — | — |
| `data` | **yes** | `Schema.String` | — | `inline filter` |
| `description` | no | `Schema.String` | — | — |
| `expiresAt` | no | `Schema.DateFromString` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | — |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `accountId` | **yes** | `Ids.ServiceAccountId` | — |
| `algorithm` | **yes** | `Schema.String` | — |
| `data` | **yes** | `Schema.String` | — |
| `description` | **yes** | `Schema.String` | — |
| `fingerprint` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.AuthPublicKeyId` | — |
| `keySize` | **yes** | `Schema.Finite` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.String` | — |
| `expiresAt` | no | `Schema.DateFromString` | — |

---

## `Nebius.iam.FederatedCredentials`

*Defined in [`modules/resources/iam/v1/federated-credentials.ts`](modules/resources/iam/v1/federated-credentials.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `federatedSubjectId` | **yes** | `Schema.String` | — | — |
| `oidcProvider` | **yes** | `OidcProviderSchema` | — | — |
| `oidcProvider.issuerUrl` | **yes** | `Schema.String` | — | `isValidUrl` |
| `oidcProvider.jwkSetJson` | no | `Schema.String` | — | — |
| `subjectId` | **yes** | `Ids.ServiceAccountId` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | — |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `federatedSubjectId` | **yes** | `Schema.String` | See the props schema: an external IdP subject, deliberately unbranded. |
| `id` | **yes** | `Ids.FederatedCredentialsId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `subjectId` | **yes** | `Ids.ServiceAccountId` | — |
| `oidcProvider` | no | `OidcProviderSchema` | — |

---

## `Nebius.iam.Federation`

*Defined in [`modules/resources/iam/v1/federation.ts`](modules/resources/iam/v1/federation.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `samlSettings` | **yes** | `SamlSettingsSchema` | — | — |
| `samlSettings.idpIssuer` | **yes** | `Schema.String` | — | `isValidUrl` |
| `samlSettings.ssoUrl` | **yes** | `Schema.String` | — | `isValidUrl` |
| `samlSettings.forceAuthn` | no | `Schema.Boolean` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.TenantId` | NEBIUS_TENANT_ID | — |
| `userAccountAutoCreation` | no | `Schema.Boolean` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `certificatesCount` | **yes** | `Schema.Number` | — |
| `id` | **yes** | `Ids.FederationId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.TenantId` | — |
| `state` | **yes** | `Schema.String` | — |
| `usersCount` | **yes** | `Schema.Number` | — |
| `samlSettings` | no | `SamlSettingsSchema` | — |
| `userAccountAutoCreation` | no | `Schema.Boolean` | — |

---

## `Nebius.iam.FederationCertificate`

*Defined in [`modules/resources/iam/v1/federation-certificate.ts`](modules/resources/iam/v1/federation-certificate.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `data` | **yes** | `Schema.String` | — | `isPemFormat` |
| `parentId` | **yes** | `Ids.FederationId` | — | — |
| `description` | no | `Schema.String` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `algorithm` | **yes** | `Schema.String` | — |
| `data` | **yes** | `Schema.String` | — |
| `description` | **yes** | `Schema.String` | — |
| `fingerprint` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.FederationCertificateId` | — |
| `keySize` | **yes** | `Schema.String` | Size of the certificate key in bits, as the platform reports it. |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `Ids.FederationId` | — |
| `state` | **yes** | `Schema.String` | — |
| `notAfter` | no | `Schema.DateFromString` | — |
| `notBefore` | no | `Schema.DateFromString` | — |

---

## `Nebius.iam.Group`

*Defined in [`modules/resources/iam/v1/group.ts`](modules/resources/iam/v1/group.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.GroupId` | — |
| `membersCount` | **yes** | `Schema.Number` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `serviceAccountsCount` | **yes** | `Schema.Number` | — |
| `state` | **yes** | `Schema.String` | — |
| `tenantUserAccountsCount` | **yes** | `Schema.Number` | — |

---

## `Nebius.iam.GroupMembership`

*Defined in [`modules/resources/iam/v1/group-membership.ts`](modules/resources/iam/v1/group-membership.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `memberId` | **yes** | `Ids.GroupMembershipMemberId` | — | — |
| `parentId` | **yes** | `Ids.GroupId` | — | — |
| `revokeAfterHours` | no | `Schema.Finite` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.GroupMembershipId` | — |
| `memberId` | **yes** | `Ids.GroupMembershipMemberId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `Ids.GroupId` | — |
| `memberKind` | no | `Schema.String` | — |
| `revokeAt` | no | `Schema.DateFromString` | When the membership is revoked. |

---

## `Nebius.iam.Invitation`

*Defined in [`modules/resources/iam/v1/invitation.ts`](modules/resources/iam/v1/invitation.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `email` | **yes** | `Schema.String` | — | `isValidEmail` |
| `description` | no | `Schema.String` | — | — |
| `expiresInSeconds` | no | `Schema.Finite` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `noSend` | no | `Schema.Boolean` | — | — |
| `parentId` | no | `IamV2Ids.TenantId` | NEBIUS_TENANT_ID | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `description` | **yes** | `Schema.String` | — |
| `email` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.InvitationId` | — |
| `parentId` | **yes** | `IamV2Ids.TenantId` | — |
| `state` | **yes** | `Schema.String` | — |
| `expiresAt` | no | `Schema.DateFromString` | — |
| `tenantUserAccountId` | no | `Ids.TenantUserAccountId` | The tenant user account created by the invitation. |

---

## `Nebius.iam.Project`

*Defined in [`modules/resources/iam/v2/project.ts`](modules/resources/iam/v2/project.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `region` | **yes** | `RegionsSchema.RegionSchema` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `Ids.TenantId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.ProjectId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `Ids.TenantId` | — |
| `region` | **yes** | `RegionsSchema.RegionSchema` | — |
| `state` | **yes** | `Schema.Union([ Schema.Literal('STATE_UNSPECIFIED'), Schema.Literal('CREATING'), Schema.Literal('ACTIVE'), Schema.Literal('PURGING'), Schema.Literal('CREATED'), Schema.Literal('ACTIVATING'), Schema.Literal('PARKING'), Schema.Literal('PARKED'), ])` | — |

---

## `Nebius.iam.ServiceAccount`

*Defined in [`modules/resources/iam/v1/service-account.ts`](modules/resources/iam/v1/service-account.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `description` | no | `Schema.String` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `active` | **yes** | `Schema.Boolean` | — |
| `description` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.ServiceAccountId` | — |
| `labels` | **yes** | `Schema.Record(Schema.String, Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |

---

## `Nebius.iam.StaticKey`

*Defined in [`modules/resources/iam/v1/static-key.ts`](modules/resources/iam/v1/static-key.ts). Narrative and live-verification status: [README.md § IAM & Access](README.md#iam-access).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `serviceAccountId` | **yes** | `Ids.ServiceAccountId` | — | — |
| `description` | no | `Schema.String` | — | — |
| `expiresAt` | no | `Schema.DateFromString` | — | — |
| `service` | no | `StaticKeyService` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `accessKey` | **yes** | `Schema.String` | The one-time access key token. |
| `active` | **yes** | `Schema.Boolean` | — |
| `description` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.StaticKeyId` | — |
| `secretKey` | **yes** | `Schema.String` | The one-time secret key. |
| `service` | **yes** | `Schema.String` | — |
| `serviceAccountId` | **yes** | `Ids.ServiceAccountId` | — |
| `createdAt` | no | `Schema.DateFromString` | — |
| `expiresAt` | no | `Schema.DateFromString` | — |

---

## `Nebius.kms.AsymmetricKey`

*Defined in [`modules/resources/kms/v1/asymmetric-key.ts`](modules/resources/kms/v1/asymmetric-key.ts). Narrative and live-verification status: [README.md § KMS](README.md#kms).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `algorithm` | no | `AsymmetricAlgorithmSchema` | — | — |
| `description` | no | `Schema.String` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `algorithm` | **yes** | `AsymmetricAlgorithmSchema` | — |
| `description` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.AsymmetricKeyId` | — |
| `labels` | **yes** | `Schema.Record(Schema.String, Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.String` | — |

---

## `Nebius.kms.SymmetricKey`

*Defined in [`modules/resources/kms/v1/symmetric-key.ts`](modules/resources/kms/v1/symmetric-key.ts). Narrative and live-verification status: [README.md § KMS](README.md#kms).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `algorithm` | no | `SymmetricAlgorithmSchema` | AES_256 | — |
| `description` | no | `Schema.String` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `rotationPeriodSeconds` | no | `Schema.Finite` | the platform default applies | `isValidRotationPeriodSeconds` |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `algorithm` | **yes** | `SymmetricAlgorithmSchema` | — |
| `description` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.SymmetricKeyId` | — |
| `labels` | **yes** | `Schema.Record(Schema.String, Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.String` | — |

---

## `Nebius.mk8s.Cluster`

*Defined in [`modules/resources/mk8s/v1/cluster.ts`](modules/resources/mk8s/v1/cluster.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `subnetId` | **yes** | `VpcIds.SubnetId` | — | — |
| `auditLogs` | no | `Schema.Boolean` | — | `presenceOnly('auditLogs', 'cluster')` |
| `etcdClusterSize` | no | `Schema.Finite` | — | `etcdClusterSizeValid` |
| `karpenter` | no | `Schema.Boolean` | — | `presenceOnly('karpenter', 'cluster')` |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `publicEndpoint` | no | `{ … }` | — | `isValidCIDR` |
| `publicEndpoint.allowedCidrs` | no | `Schema.Array(Schema.String)` | — | — |
| `serviceCidrs` | no | `Schema.Array(Schema.String)` | — | `kubeServiceCidrValid` |
| `version` | no | `Schema.String` | — | `versionValid` |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.ClusterId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `clusterCaCertificate` | no | `Schema.String` | PEM bundle of the cluster certificate authority, for TLS to the API endpoint. |
| `endpoints` | no | `{ … }` | Where the Kubernetes API answers. |
| `etcdClusterSize` | no | `Schema.String` | etcd instance count, int64 on the wire → decimal **string** here. |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — |
| `reconciling` | no | `Schema.Boolean` | An operation is in flight on the cluster. |
| `requestedVersion` | no | `Schema.String` | The version **requested** in `spec` — absent when the cluster was created without one (the recommended configuration, and the only case where the backend picks). |
| `state` | no | `Schema.String` | `PROVISIONING` / `RUNNING` / `DELETING` (`STATE_UNSPECIFIED` maps to omitted). |
| `subnetId` | no | `VpcIds.SubnetId` | Control-plane subnet (immutable after creation). |
| `version` | no | `Schema.String` | The version the control plane is **actually running** (`status`), e.g. |

---

## `Nebius.mk8s.NodeGroup`

*Defined in [`modules/resources/mk8s/v1/node-group.ts`](modules/resources/mk8s/v1/node-group.ts). Narrative and live-verification status: [README.md § Compute](README.md#compute).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `parentId` | **yes** | `Ids.ClusterId` | — | — |
| `template` | **yes** | `NodeGroupTemplateSchema` | — | — |
| `template.bootDisk` | **yes** | `BootDiskSchema` | — | — |
| `template.cloudInitUserData` | **yes** | `Schema.String` | — | `isNonEmptyString('template.cloudInitUserData')` |
| `template.os` | **yes** | `Schema.String` | — | `isNonEmptyString('template.os')` |
| `template.resources` | **yes** | `{ … }` | — | `isNonEmptyString('template.resources.platform')` `isNonEmptyString('template.resources.preset')` |
| `template.serviceAccountId` | **yes** | `IamIds.ServiceAccountId` | — | — |
| `template.filesystems` | no | `Schema.Array( { … })` | — | `isValidMountTag` |
| `template.gpuCluster` | no | `GpuClusterSchema` | — | — |
| `template.gpuSettings` | no | `GpuSettingsSchema` | — | — |
| `template.instanceMetadata` | no | `{ … }` | — | — |
| `template.localDisks` | no | `LocalDisksSchema` | — | — |
| `template.maxPods` | no | `Schema.Finite` | let the platform choose | `positiveCount('template.maxPods')` |
| `template.metadata` | no | `{ … }` | — | — |
| `template.networkInterfaces` | no | `Schema.Array(NetworkInterfaceSchema)` | — | — |
| `template.nvlink` | no | `NVLinkSchema` | — | — |
| `template.preemptible` | no | `Schema.Boolean` | — | `presenceOnly('template.preemptible', 'node group')` |
| `template.pricing` | no | `PricingModelSchema` | — | — |
| `template.reservationPolicy` | no | `ReservationPolicySchema` | — | — |
| `template.taints` | no | `Schema.Array( { … })` | — | `isNonEmptyString('template.taints[].key')` |
| `autoRepair` | no | `AutoRepairSchema` | — | — |
| `autoRepair.conditions` | **yes** | `Schema.Array( { … })` | — | `isNonEmptyString('autoRepair.conditions[].type')` `positiveSeconds('autoRepair.conditions[].timeoutSeconds')` `inline filter` `inline filter` |
| `autoscaling` | no | `{ … }` | — | `positiveCount('autoscaling.minNodeCount')` `positiveCount('autoscaling.maxNodeCount')` `inline filter` |
| `autoscaling.maxNodeCount` | **yes** | `Schema.Finite` | — | — |
| `autoscaling.minNodeCount` | **yes** | `Schema.Finite` | — | — |
| `fixedNodeCount` | no | `Schema.Finite` | — | `positiveCount('fixedNodeCount')` |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `strategy` | no | `StrategySchema` | — | — |
| `strategy.drainTimeoutSeconds` | no | `Schema.Finite` | — | `positiveSeconds('strategy.drainTimeoutSeconds')` |
| `strategy.maxSurge` | no | `percentOrCount('strategy.maxSurge')` | — | — |
| `strategy.maxUnavailable` | no | `percentOrCount('strategy.maxUnavailable')` | — | — |
| `version` | no | `Schema.String` | — | `versionValid` |

Resource-level validations (they compare several props, so they are not attached to one row): `exactlyOneSizing`, `nvLinkPreconditions`.

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.NodeGroupId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `Ids.ClusterId` | The parent **cluster** id. |
| `drainTimeoutSeconds` | no | `Schema.String` | How long a node may be drained during a roll-out before the drain is cut short — the **effective** value, whole seconds as a decimal string (`0` means draining is not time-limited). |
| `fixedNodeCount` | no | `Schema.String` | Requested node count (`spec.fixedNodeCount`), int64 → decimal **string**. |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — |
| `maxSurge` | no | `{ … }` | Extra nodes provisioned above the desired count during a roll-out, same `{ count \\| percent }` shape. |
| `nodeCount` | no | `Schema.String` | Nodes currently in the group, ready and not ready. |
| `outdatedNodeCount` | no | `Schema.String` | Nodes whose configuration is outdated and which a roll-out will replace. |
| `readyNodeCount` | no | `Schema.String` | Nodes that joined the cluster and are ready to serve workloads. |
| `reconciling` | no | `Schema.Boolean` | An operation is in flight on the node group. |
| `requestedVersion` | no | `Schema.String` | The version **requested** in `spec` — absent when the group inherited the cluster's. |
| `state` | no | `Schema.String` | `PROVISIONING` / `RUNNING` / `DELETING` (`STATE_UNSPECIFIED` maps to omitted). |
| `targetNodeCount` | no | `Schema.String` | Desired total node count right now (fixed count, or the autoscaler's current target). |
| `version` | no | `Schema.String` | The version the nodes actually run (`status.version`), in the long `v<major>.<minor>.<patch>-nebius-node.<infra_version>` form — measured live 2026-09-23 as `v1.36.3-nebius-node.75` (the `v` *is* part of it). |

---

## `Nebius.mysterybox.Secret`

*Defined in [`modules/resources/mysterybox/v1/secret.ts`](modules/resources/mysterybox/v1/secret.ts). Narrative and live-verification status: [README.md § Secrets (MysteryBox)](README.md#secrets-mysterybox).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `description` | no | `Schema.String` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `payloads` | no | `Schema.Array(PayloadEntrySchema)` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `description` | **yes** | `Schema.String` | — |
| `effectiveKmsKeyId` | **yes** | `KmsIds.KmsKeyId` | — |
| `id` | **yes** | `Ids.SecretId` | — |
| `labels` | **yes** | `Schema.Record(Schema.String, Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([Schema.Literal('ACTIVE'), Schema.Literal('SCHEDULED_FOR_DELETION')])` | — |

---

## `Nebius.mysterybox.SecretVersion`

*Defined in [`modules/resources/mysterybox/v1/secret-version.ts`](modules/resources/mysterybox/v1/secret-version.ts). Narrative and live-verification status: [README.md § Secrets (MysteryBox)](README.md#secrets-mysterybox).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `parentId` | **yes** | `Ids.SecretId` | — | — |
| `payload` | **yes** | `Schema.Array(PayloadEntrySchema)` | — | — |
| `description` | no | `Schema.String` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | `sv-<logicalId>` | — |
| `setPrimary` | no | `Schema.Boolean` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `description` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.SecretVersionId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `Ids.SecretId` | — |
| `state` | **yes** | `Schema.String` | — |
| `deletedAt` | no | `Schema.DateFromString` | — |
| `purgeAt` | no | `Schema.DateFromString` | — |

---

## `Nebius.quotas.QuotaAllowance`

*Defined in [`modules/resources/quotas/v1/quota-allowance.ts`](modules/resources/quotas/v1/quota-allowance.ts). Narrative and live-verification status: [README.md § Quotas](README.md#quotas).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `name` | **yes** | `Schema.String` | — | — |
| `region` | **yes** | `RegionsSchema.RegionSchema` | — | — |
| `limit` | no | `Schema.String` | — | — |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `description` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Schema.String` | NOT branded, and not stable: a QuotaAllowance has no server-assigned ID (identity is `(parentId, name, region)` — see AGENTS.md), and the API can return `""` here. |
| `limit` | **yes** | `Schema.String` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `region` | **yes** | `RegionsSchema.RegionSchema` | — |
| `service` | **yes** | `Schema.String` | — |
| `serviceDescription` | **yes** | `Schema.String` | — |
| `state` | **yes** | `Schema.String` | — |
| `unit` | **yes** | `Schema.String` | — |
| `usage` | **yes** | `Schema.String` | — |
| `usagePercentage` | **yes** | `Schema.String` | — |
| `usageState` | **yes** | `Schema.String` | — |

---

## `Nebius.storage.Bucket`

*Defined in [`modules/resources/storage/v1/bucket.ts`](modules/resources/storage/v1/bucket.ts). Narrative and live-verification status: [README.md § Storage](README.md#storage).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `bucketPolicy` | no | `BucketPolicySchema` | — | — |
| `bucketPolicy.rules` | **yes** | `Schema.Array(BucketPolicy_RuleSchema)` | — | — |
| `cors` | no | `CORSConfigurationSchema` | — | — |
| `cors.rules` | **yes** | `Schema.Array(CORSRuleSchema)` | — | — |
| `defaultStorageClass` | no | `Schema.Union([ Schema.Literal('STANDARD'), Schema.Literal('ENHANCED_THROUGHPUT'), Schema.Literal('INTELLIGENT'), Schema.Literal('FILESYSTEM'), ])` | — | — |
| `forceStorageClass` | no | `Schema.Boolean` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `lifecycleConfiguration` | no | `LifecycleConfigurationSchema` | — | — |
| `lifecycleConfiguration.rules` | **yes** | `Schema.Array(LifecycleRuleSchema)` | — | — |
| `lifecycleConfiguration.lastAccessFilter` | no | `LifecycleAccessFilterSchema` | — | — |
| `maxSizeBytes` | no | `Schema.BigInt` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `objectAuditLogging` | no | `Schema.Union([Schema.Literal('NONE'), Schema.Literal('MUTATE_ONLY'), Schema.Literal('ALL')])` | — | — |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `versioningPolicy` | no | `Schema.Union([Schema.Literal('DISABLED'), Schema.Literal('ENABLED'), Schema.Literal('SUSPENDED')])` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `defaultStorageClass` | **yes** | `Schema.Union([ Schema.Literal('STANDARD'), Schema.Literal('ENHANCED_THROUGHPUT'), Schema.Literal('INTELLIGENT'), Schema.Literal('FILESYSTEM'), ])` | — |
| `id` | **yes** | `Ids.BucketId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `objectAuditLogging` | **yes** | `Schema.Union([Schema.Literal('NONE'), Schema.Literal('MUTATE_ONLY'), Schema.Literal('ALL')])` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([ Schema.Literal('CREATING'), Schema.Literal('ACTIVE'), Schema.Literal('UPDATING'), Schema.Literal('SCHEDULED_FOR_DELETION'), ])` | — |
| `suspensionState` | **yes** | `Schema.Union([Schema.Literal('NOT_SUSPENDED'), Schema.Literal('SUSPENDED')])` | — |
| `versioningPolicy` | **yes** | `Schema.Union([Schema.Literal('DISABLED'), Schema.Literal('ENABLED'), Schema.Literal('SUSPENDED')])` | — |

---

## `Nebius.storage.Transfer`

*Defined in [`modules/resources/storage/v1/transfer.ts`](modules/resources/storage/v1/transfer.ts). Narrative and live-verification status: [README.md § Storage](README.md#storage).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `destination` | **yes** | `TransferDestinationSchema` | — | — |
| `overwriteStrategy` | **yes** | `OverwriteStrategy` | — | — |
| `source` | **yes** | `TransferSourceSchema` | — | — |
| `stopCondition` | **yes** | `StopConditionSchema` | — | — |
| `enableDeletesInDestination` | no | `Schema.Boolean` | — | — |
| `interIterationIntervalSeconds` | no | `Schema.Number` | 900 | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `limiters` | no | `LimitersSchema` | — | — |
| `limiters.bandwidthBytesPerSecond` | no | `Schema.Number` | — | — |
| `limiters.requestsPerSecond` | no | `Schema.Number` | — | — |
| `name` | no | `Schema.String` | — | — |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `touchUnmanaged` | no | `Schema.Boolean` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.TransferId` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.String` | — |
| `lastIteration` | no | `{ … }` | — |
| `suspensionState` | no | `Schema.String` | — |

---

## `Nebius.vpc.Allocation`

*Defined in [`modules/resources/vpc/v1/allocation.ts`](modules/resources/vpc/v1/allocation.ts). Narrative and live-verification status: [README.md § Networking (VPC)](README.md#networking-vpc).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `ipv4Private` | no | `IPv4AllocationSpecSchema` | — | — |
| `ipv4Private.cidr` | **yes** | `Schema.String` | — | `isValidCIDR` |
| `ipv4Private.poolId` | no | `Ids.PoolId` | — | — |
| `ipv4Private.subnetId` | no | `Ids.SubnetId` | — | — |
| `ipv4Public` | no | `IPv4AllocationSpecSchema` | — | — |
| `ipv4Public.cidr` | **yes** | `Schema.String` | — | `isValidCIDR` |
| `ipv4Public.poolId` | no | `Ids.PoolId` | — | — |
| `ipv4Public.subnetId` | no | `Ids.SubnetId` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

Resource-level validations (they compare several props, so they are not attached to one row): `allocationValid`.

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.AllocationId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([ Schema.Literal('CREATING'), Schema.Literal('ALLOCATED'), Schema.Literal('ASSIGNED'), Schema.Literal('DELETING'), ])` | — |

---

## `Nebius.vpc.Network`

*Defined in [`modules/resources/vpc/v1/network.ts`](modules/resources/vpc/v1/network.ts). Narrative and live-verification status: [README.md § Networking (VPC)](README.md#networking-vpc).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `ipv4PrivatePools` | no | `IPv4PrivatePoolsSchema` | — | — |
| `ipv4PrivatePools.pools` | **yes** | `Schema.Array(NetworkPoolSchema)` | — | — |
| `ipv4PublicPools` | no | `IPv4PublicPoolsSchema` | — | — |
| `ipv4PublicPools.pools` | **yes** | `Schema.Array(NetworkPoolSchema)` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `defaultRouteTableId` | **yes** | `Ids.RouteTableId` | — |
| `id` | **yes** | `Ids.NetworkId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('DELETING')])` | — |

---

## `Nebius.vpc.Pool`

*Defined in [`modules/resources/vpc/v1/pool.ts`](modules/resources/vpc/v1/pool.ts). Narrative and live-verification status: [README.md § Networking (VPC)](README.md#networking-vpc).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `cidrs` | **yes** | `Schema.Array(PoolCIDRSchema)` | — | — |
| `version` | **yes** | `Schema.Union([Schema.Literal('IPV4'), Schema.Literal('IPV6')])` | — | — |
| `visibility` | **yes** | `Schema.Union([Schema.Literal('PRIVATE'), Schema.Literal('PUBLIC')])` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `sourcePoolId` | no | `Ids.PoolId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.PoolId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `scopeId` | **yes** | `Ids.PoolScopeId` | — |
| `state` | **yes** | `Schema.Union([Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('DELETING')])` | — |
| `version` | **yes** | `Schema.Union([Schema.Literal('IPV4'), Schema.Literal('IPV6')])` | — |
| `visibility` | **yes** | `Schema.Union([Schema.Literal('PRIVATE'), Schema.Literal('PUBLIC')])` | — |

---

## `Nebius.vpc.Route`

*Defined in [`modules/resources/vpc/v1/route.ts`](modules/resources/vpc/v1/route.ts). Narrative and live-verification status: [README.md § Networking (VPC)](README.md#networking-vpc).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `parentId` | **yes** | `Ids.RouteTableId` | — | — |
| `description` | no | `Schema.String` | — | — |
| `destination` | no | `DestinationMatchSchema` | — | — |
| `destination.cidr` | **yes** | `Schema.String` | — | `isValidCIDR` |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `nextHop` | no | `NextHopSchema` | — | — |
| `nextHop.allocation` | no | `AllocationNextHopSchema` | — | — |
| `nextHop.defaultEgressGateway` | no | `Schema.Boolean` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `description` | **yes** | `Schema.String` | — |
| `id` | **yes** | `Ids.RouteId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `Ids.RouteTableId` | — |
| `state` | **yes** | `Schema.Union([Schema.Literal('READY')])` | — |

---

## `Nebius.vpc.RouteTable`

*Defined in [`modules/resources/vpc/v1/route-table.ts`](modules/resources/vpc/v1/route-table.ts). Narrative and live-verification status: [README.md § Networking (VPC)](README.md#networking-vpc).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `networkId` | **yes** | `Ids.NetworkId` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `default` | **yes** | `Schema.Boolean` | — |
| `id` | **yes** | `Ids.RouteTableId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `networkId` | **yes** | `Ids.NetworkId` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([Schema.Literal('READY')])` | — |
| `assignment` | no | `{ … }` | — |

---

## `Nebius.vpc.SecurityGroup`

*Defined in [`modules/resources/vpc/v1/security-group.ts`](modules/resources/vpc/v1/security-group.ts). Narrative and live-verification status: [README.md § Networking (VPC)](README.md#networking-vpc).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `networkId` | **yes** | `Ids.NetworkId` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `default` | **yes** | `Schema.Boolean` | — |
| `id` | **yes** | `Ids.SecurityGroupId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `networkId` | **yes** | `Ids.NetworkId` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `state` | **yes** | `Schema.Union([Schema.Literal('READY')])` | — |

---

## `Nebius.vpc.SecurityRule`

*Defined in [`modules/resources/vpc/v1/security-rule.ts`](modules/resources/vpc/v1/security-rule.ts). Narrative and live-verification status: [README.md § Networking (VPC)](README.md#networking-vpc).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `access` | **yes** | `Schema.Union([Schema.Literal('ALLOW'), Schema.Literal('DENY')])` | — | — |
| `direction` | **yes** | `Schema.Union([Schema.Literal('INGRESS'), Schema.Literal('EGRESS')])` | — | — |
| `parentId` | **yes** | `Ids.SecurityGroupId` | — | — |
| `protocol` | **yes** | `Schema.Union([Schema.Literal('ANY'), Schema.Literal('TCP'), Schema.Literal('UDP'), Schema.Literal('ICMP')])` | — | — |
| `egress` | no | `RuleEgressSchema` | — | — |
| `egress.destinationCidrs` | no | `Schema.Array(Schema.String)` | — | — |
| `egress.destinationPorts` | no | `Schema.Array(Schema.Finite)` | — | `isValidPort` |
| `egress.destinationSecurityGroupId` | no | `Ids.SecurityGroupId` | — | — |
| `ingress` | no | `RuleIngressSchema` | — | — |
| `ingress.destinationPorts` | no | `Schema.Array(Schema.Finite)` | — | `isValidPort` |
| `ingress.sourceCidrs` | no | `Schema.Array(Schema.String)` | — | — |
| `ingress.sourceSecurityGroupId` | no | `Ids.SecurityGroupId` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `priority` | no | `Schema.Finite` | — | — |
| `type` | no | `Schema.Union([Schema.Literal('STATEFUL'), Schema.Literal('STATELESS')])` | — | — |

Resource-level validations (they compare several props, so they are not attached to one row): `securityRuleValid`.

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `access` | **yes** | `Schema.Union([Schema.Literal('ALLOW'), Schema.Literal('DENY')])` | — |
| `direction` | **yes** | `Schema.Union([Schema.Literal('INGRESS'), Schema.Literal('EGRESS')])` | — |
| `effectivePriority` | **yes** | `Schema.Finite` | — |
| `id` | **yes** | `Ids.SecurityRuleId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `parentId` | **yes** | `Ids.SecurityGroupId` | — |
| `priority` | **yes** | `Schema.Finite` | — |
| `protocol` | **yes** | `Schema.Union([Schema.Literal('ANY'), Schema.Literal('TCP'), Schema.Literal('UDP'), Schema.Literal('ICMP')])` | — |
| `state` | **yes** | `Schema.Union([Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('DELETING')])` | — |
| `type` | **yes** | `Schema.Union([Schema.Literal('STATEFUL'), Schema.Literal('STATELESS')])` | — |

---

## `Nebius.vpc.Subnet`

*Defined in [`modules/resources/vpc/v1/subnet.ts`](modules/resources/vpc/v1/subnet.ts). Narrative and live-verification status: [README.md § Networking (VPC)](README.md#networking-vpc).*

| prop | required | type | documented default | plan-time validation |
| --- | --- | --- | --- | --- |
| `networkId` | **yes** | `Ids.NetworkId` | — | — |
| `ipv4PrivatePools` | no | `IPv4PrivateSubnetPoolsSchema` | — | — |
| `ipv4PrivatePools.pools` | **yes** | `Schema.Array(SubnetPoolSchema)` | — | — |
| `ipv4PrivatePools.useNetworkPools` | no | `Schema.Boolean` | — | — |
| `ipv4PublicPools` | no | `IPv4PublicSubnetPoolsSchema` | — | — |
| `ipv4PublicPools.pools` | **yes** | `Schema.Array(SubnetPoolSchema)` | — | — |
| `ipv4PublicPools.useNetworkPools` | no | `Schema.Boolean` | — | — |
| `labels` | no | `Schema.Record(Schema.String, Schema.String)` | — | — |
| `name` | no | `Schema.String` | — | `isDnsCompliantResourceName` |
| `parentId` | no | `IamV2Ids.ProjectId` | — | — |
| `routeTableId` | no | `Ids.RouteTableId` | — | — |

### Returned values

| attribute | always present | type | documented as |
| --- | --- | --- | --- |
| `id` | **yes** | `Ids.SubnetId` | — |
| `labels` | **yes** | `Schema.Array(Schema.String)` | — |
| `name` | **yes** | `Schema.String` | — |
| `networkId` | **yes** | `Ids.NetworkId` | — |
| `parentId` | **yes** | `IamV2Ids.ProjectId` | — |
| `routeTableId` | **yes** | `Ids.RouteTableId` | — |
| `state` | **yes** | `Schema.Union([Schema.Literal('CREATING'), Schema.Literal('READY'), Schema.Literal('DELETING')])` | — |
| `associatedRouteTable` | no | `SubnetAssociatedRouteTableSchema` | — |

---
