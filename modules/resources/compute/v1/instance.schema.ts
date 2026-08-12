import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'
import * as Ids from './ids.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Nested sub-schemas
// ---------------------------------------------------------------------------

const RecoveryPolicySchema = Schema.Union([Schema.Literal('RECOVER'), Schema.Literal('FAIL')])

// ---------------------------------------------------------------------------
// Platforms & Presets
// ---------------------------------------------------------------------------

const PlatformSchema = Schema.Union([
  Schema.Literal('cpu-d3'),
  Schema.Literal('gpu-h200-sxm'),
])

const PresetSchema = Schema.Union([
  // cpu-d3 presets (AMD Epyc Genoa)
  Schema.Literal('4vcpu-16gb'),
  Schema.Literal('8vcpu-32gb'),
  Schema.Literal('16vcpu-64gb'),
  Schema.Literal('32vcpu-128gb'),
  Schema.Literal('48vcpu-192gb'),
  Schema.Literal('64vcpu-256gb'),
  Schema.Literal('96vcpu-384gb'),
  Schema.Literal('128vcpu-512gb'),
  Schema.Literal('160vcpu-640gb'),
  Schema.Literal('192vcpu-768gb'),
  Schema.Literal('224vcpu-896gb'),
  Schema.Literal('256vcpu-1024gb'),
  // gpu-h200-sxm presets (NVIDIA H200 NVLink)
  Schema.Literal('1gpu-16vcpu-200gb'),
  Schema.Literal('8gpu-128vcpu-1600gb'),
])

const cpuPresets = new Set([
  '4vcpu-16gb',
  '8vcpu-32gb',
  '16vcpu-64gb',
  '32vcpu-128gb',
  '48vcpu-192gb',
  '64vcpu-256gb',
  '96vcpu-384gb',
  '128vcpu-512gb',
  '160vcpu-640gb',
  '192vcpu-768gb',
  '224vcpu-896gb',
  '256vcpu-1024gb',
])

const gpuPresets = new Set(['1gpu-16vcpu-200gb', '8gpu-128vcpu-1600gb'])

const presetMatchesPlatform = Schema.makeFilter((props: Record<string, unknown>) => {
  const platform = props.platform as string
  const preset = props.preset as string | undefined
  if (!preset) return []
  if (platform === 'cpu-d3' && !cpuPresets.has(preset)) {
    return [{ path: ['preset'], issue: `Preset "${preset}" is not valid for platform "cpu-d3". Valid: ${[...cpuPresets].join(', ')}` }]
  }
  if (platform === 'gpu-h200-sxm' && !gpuPresets.has(preset)) {
    return [{ path: ['preset'], issue: `Preset "${preset}" is not valid for platform "gpu-h200-sxm". Valid: ${[...gpuPresets].join(', ')}` }]
  }
  return []
})

const ResourcesSpecSchema = Schema.Struct({
  /** CPU/GPU platform, e.g. "cpu-d3", "gpu-h200-sxm". */
  platform: PlatformSchema,
  /** Preset name (mutually exclusive with explicit cpu/memory). */
  preset: Schema.optional(PresetSchema),
}).check(presetMatchesPlatform)

const AttachModeSchema = Schema.Union([Schema.Literal('READ_ONLY'), Schema.Literal('READ_WRITE')])

const DiskTypeSchema = Schema.Union([
  Schema.Literal('NETWORK_SSD'),
  Schema.Literal('NETWORK_HDD'),
  Schema.Literal('NETWORK_SSD_NON_REPLICATED'),
  Schema.Literal('NETWORK_SSD_IO_M3'),
])

/** Source image family to create the disk from the latest image (the platform resolves it). */
const SourceImageFamilySchema = Schema.Struct({
  imageFamily: Schema.String,
  /** Defaults to the region's public-images parent (`project-<region>public-images`). */
  parentId: Schema.optional(Schema.String),
})

/**
 * Nebius provisions a BLANK boot disk when no source image is given — no OS,
 * no serial output, every port dropped (looks RUNNING, serves nothing). Fail
 * fast with a clear message instead of a dead VM.
 */
const bootDiskImageRequired = Schema.makeFilter((spec: Record<string, unknown>) => {
  if (spec.sourceImageId === undefined && spec.sourceImageFamily === undefined) {
    return {
      path: ['sourceImageId'],
      issue:
        'Boot disk requires an OS image: set `sourceImageId`, or `sourceImageFamily: { imageFamily: "ubuntu24.04-driverless" }` — without one Nebius provisions a blank disk (no OS, no serial output, all ports dropped)',
    }
  }
})

const ManagedDiskSpecSchema = Schema.Struct({
  /** Disk size in gibibytes. Must be ≥ 64 GiB when set — smaller disks hang provisioning (platform behavior). */
  sizeGibibytes: Schema.optional(Schema.Finite.check(Validation.isValidBootDiskSizeGibibytes)),
  /** Block size in bytes. Default: 4096. */
  blockSizeBytes: Schema.optional(Schema.Finite),
  /** Disk type determines performance and reliability characteristics. */
  type: DiskTypeSchema,
  /** ID of the source image to create the disk from. */
  sourceImageId: Schema.optional(Ids.ImageId),
  /** Source image family to create the disk from the latest image (the platform resolves it — see `SourceImageFamily`). */
  sourceImageFamily: Schema.optional(SourceImageFamilySchema),
  /** Prevents deletion whilst set. */
  forbidDeletion: Schema.optional(Schema.Boolean),
}).check(bootDiskImageRequired)

const ManagedDiskSchema = Schema.Struct({
  name: Schema.String,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Specification of the managed disk to be created. Required by the API. */
  spec: Schema.optional(ManagedDiskSpecSchema),
})

const ExistingDiskSchema = Schema.Struct({
  id: Schema.String,
})

const AttachedDiskSpecSchema = Schema.Struct({
  attachMode: AttachModeSchema,
  /** Attach an existing disk by ID (preserved on instance delete). */
  existingDisk: Schema.optional(ExistingDiskSchema),
  /** Create a managed disk (deleted with the instance). */
  managedDisk: Schema.optional(ManagedDiskSchema),
  /** User-defined device identifier for /dev/disk/by-id/virtio-{device_id}. */
  deviceId: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter((props: Record<string, unknown>) => {
    if (!props.existingDisk && !props.managedDisk) {
      return {
        path: [],
        issue: 'Boot disk must specify either existingDisk or managedDisk',
      }
    }
  }),
)

const SecurityGroupIdSchema = Schema.Struct({
  id: Schema.String,
})

const IPAddressSchema = Schema.Struct({
  /** Allocation identifier if it was created before. */
  allocationId: Schema.String,
})

const PublicIPAddressSchema = Schema.Struct({
  /** Allocation identifier if it was created before. */
  allocationId: Schema.optional(Schema.String),
  /**
   * If false - Allocation will be created/deleted during NetworkInterface.Allocate/Deallocate.
   * If true  - Allocation will be created/deleted during NetworkInterface.Create/Delete.
   * False by default.
   */
  static: Schema.Boolean,
})

/**
 * The Nebius compute API rejects a network interface without `ipAddress`
 * (`spec.network_interfaces[0].ip_address: value is required`) — catch it at
 * validation time with a clear message instead of a raw gRPC rejection.
 */
const networkInterfaceValid = Schema.makeFilter((networkInterface: Record<string, unknown>) => {
  if (networkInterface.ipAddress === undefined) {
    return {
      path: ['ipAddress'],
      issue: 'Network interface requires `ipAddress` (use `{ allocationId: "" }` for auto-allocation) — the API rejects a missing ip_address',
    }
  }
})

const NetworkInterfaceSpecSchema = Schema.Struct({
  /** Subnet ID to attach this interface to. */
  subnetId: Schema.String,
  /** Interface name (truncated to 15 chars inside VM OS). Required by the API. */
  name: Schema.String,
  /** Private IPv4 address associated with the interface. The API REQUIRES this field (use `{ allocationId: "" }` for auto-allocation). */
  ipAddress: Schema.optional(IPAddressSchema),
  /** Public IPv4 address associated with the interface. */
  publicIpAddress: Schema.optional(PublicIPAddressSchema),
  /** Security group IDs. Empty = default security group. */
  securityGroups: Schema.optional(Schema.Array(SecurityGroupIdSchema)),
}).check(networkInterfaceValid)

const PreemptibleSchema = Schema.Struct({
  onPreemption: Schema.Literal('STOP'),
})

// ---------------------------------------------------------------------------
// Hosted runtime props (platform-level — not InstanceSpec fields)
// ---------------------------------------------------------------------------

/**
 * Bundler configuration for the hosted process entrypoint: rolldown
 * `input`/`output` overrides plus `alchemy/Bundle` options (`pure`,
 * `bundleAnalyzer`). The full rolldown option surface isn't mirrored in
 * Schema — validated as an opaque object (all keys preserved) and consumed
 * by the hosted runtime module as `Bundle.BundleConfig`.
 */
const BundleConfigSchema = Schema.Record(Schema.String, Schema.Unknown)

// ---------------------------------------------------------------------------
// Instance Props (user input)
// ---------------------------------------------------------------------------

export const InstancePropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Service account ID to associate with this instance. */
  serviceAccountId: Schema.String,
  /** Compute resources specification. */
  resources: ResourcesSpecSchema,
  /** Boot disk specification. */
  bootDisk: AttachedDiskSpecSchema,
  /** Additional data disks. */
  secondaryDisks: Schema.optional(Schema.Array(AttachedDiskSpecSchema)),
  /** Network interfaces. Must have at least one. */
  networkInterfaces: Schema.Array(NetworkInterfaceSpecSchema),
  /** GPU cluster ID for InfiniBand interconnect. Only settable at creation. */
  gpuCluster: Schema.optional(Schema.Struct({ id: Schema.String })),
  /** Recovery policy on host failure. Default: RECOVER. */
  recoveryPolicy: Schema.optional(RecoveryPolicySchema),
  /** Set to create a preemptible VM (cheaper, can be stopped by platform). */
  preemptible: Schema.optional(PreemptibleSchema),
  /** Whether the instance should be created in stopped state. */
  stopped: Schema.optional(Schema.Boolean),
  /** Hostname for the VM. Used for internal DNS: <hostname>.<network_id>.compute.internal. */
  hostname: Schema.optional(Schema.String),
  /** Cloud-init user data for instance initialization. */
  cloudInitUserData: Schema.optional(Schema.String),
  // -- Hosted runtime (platform-level, stripped before InstanceSpec.fromJSON) --
  /** Module entrypoint for the bundled instance program. When omitted, the instance behaves as a low-level Nebius compute resource. */
  main: Schema.optional(Schema.String),
  /** Named export to load from `main`. Default: "default". */
  handler: Schema.optional(Schema.String),
  /** Port exposed by the hosted process. Default: 3000. */
  port: Schema.optional(Schema.Finite.check(Validation.isValidPort)),
  /** Additional environment variables for the hosted process. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Bundler configuration for the hosted process entrypoint. */
  build: Schema.optional(BundleConfigSchema),
  /** Skip the virtual-entry wrapper — `main` is the runnable entry itself. */
  isExternal: Schema.optional(Schema.Boolean),
  /**
   * Assets bucket NAME for hosted bundles/env files. Omitted = provider-declared
   * bucket keyed on the stack id. Must be in the same project/region as the
   * instance (region-scoped S3 keys).
   */
  bucket: Schema.optional(Schema.String),
  /**
   * @internal composed by the hosted-runtime `transformProps` hook (see
   * `compute/v1/hosted.ts`) — NOT user input. Carries the lazily-declared
   * assets bucket + identity Outputs (resolved by the engine at apply time).
   */
  hosted: Schema.optional(Schema.Unknown),
})

export type InstanceProps = typeof InstancePropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateInstanceProps = Validation.makeValidateProps(InstancePropsSchema)

// ---------------------------------------------------------------------------
// Instance Attributes (output)
// ---------------------------------------------------------------------------

export const InstanceAttributesSchema = Schema.Struct({
  id: Ids.InstanceId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  serviceAccountId: Schema.String,
  state: Schema.Union([
    Schema.Literal('CREATING'),
    Schema.Literal('UPDATING'),
    Schema.Literal('STARTING'),
    Schema.Literal('RUNNING'),
    Schema.Literal('STOPPING'),
    Schema.Literal('STOPPED'),
    Schema.Literal('DELETING'),
    Schema.Literal('ERROR'),
  ]),
  /** Deterministic runtime unit name for hosted instances. */
  runtimeUnitName: Schema.optional(Schema.String),
  /** Asset prefix for hosted bundles and env files. */
  assetPrefix: Schema.optional(Schema.String),
  /** Bundle hash for hosted instances — what the VM is currently running. */
  code: Schema.optional(Schema.Struct({ hash: Schema.String })),
  // -- @internal hosted-runtime state persisted for the delete lifecycle --
  /** @internal assets bucket name for hosted artifacts (cleanup S3 objects). */
  hostedBucketName: Schema.optional(Schema.String),
  /** @internal assets bucket region (cleanup S3 endpoint). */
  hostedRegion: Schema.optional(Schema.String),
  /** @internal upload S3 access key id (cleanup creds). */
  hostedAccessKeyId: Schema.optional(Schema.String),
  /** @internal upload S3 secret access key (cleanup creds). */
  hostedSecretAccessKey: Schema.optional(Schema.String),
})

export type InstanceAttributes = typeof InstanceAttributesSchema.Type
