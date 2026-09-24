import * as Schema from 'effect/Schema'
import * as Ids from './ids.ts'

import * as Validation from '../../validation.ts'
import * as IamIds from '../../iam/v1/ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'
import * as VpcIds from '../../vpc/v1/ids.ts'
import * as CapacityIds from '../../capacity/v1/ids.ts'
import { pricingMatchesPresenceOnlyPreemptible, PricingModelSchema } from '../../shared/pricing.schema.ts'

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
  parentId: Schema.optional(IamV2Ids.ProjectId),
})

/**
 * Nebius provisions a BLANK boot disk when no source image is given — no OS,
 * no serial output, every port dropped (looks RUNNING, serves nothing). Fail
 * fast with a clear message instead of a dead VM.
 *
 * Checked on the **boot** disk only. It used to sit on `ManagedDiskSpecSchema`, which
 * rejected every managed disk without a source image — including a secondary data disk,
 * where blank is exactly right (that is how a fresh volume is added), and it blamed the
 * boot disk for a config that had one. Found by the convergence sweep's instance table,
 * which had to give its *data* disk an OS image to get past validation (2026-09-21).
 */
const bootDiskImageRequired = Schema.makeFilter(
  (props: { bootDisk?: { managedDisk?: { spec?: Record<string, unknown> } } }) => {
    const spec = props.bootDisk?.managedDisk?.spec
    // No managed spec to check: an `existingDisk` boot disk brings its own content, and a
    // `bootDisk` with neither form is rejected by `AttachedDiskSpecSchema`'s own check.
    if (spec === undefined) return undefined
    if (spec.sourceImageId === undefined && spec.sourceImageFamily === undefined) {
      return {
        path: ['bootDisk', 'managedDisk', 'spec', 'sourceImageId'],
        issue:
          'Boot disk requires an OS image: set `sourceImageId`, or `sourceImageFamily: { imageFamily: "ubuntu24.04-driverless" }` — without one Nebius provisions a blank disk (no OS, no serial output, all ports dropped)',
      }
    }
    return undefined
  },
)

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
})

const ManagedDiskSchema = Schema.Struct({
  name: Schema.String,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Specification of the managed disk to be created. Required by the API. */
  spec: Schema.optional(ManagedDiskSpecSchema),
})

const ExistingDiskSchema = Schema.Struct({
  id: Ids.DiskId,
})

const AttachedDiskSpecSchema = Schema.Struct({
  attachMode: AttachModeSchema,
  /** Attach an existing disk by ID (preserved on instance delete). */
  existingDisk: Schema.optional(ExistingDiskSchema),
  /** Create a managed disk (deleted with the instance). */
  managedDisk: Schema.optional(ManagedDiskSchema),
  /**
   * User-defined device identifier for /dev/disk/by-id/virtio-{device_id}.
   * NOT branded: a guest-side device name, not a Nebius resource ID.
   */
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
  id: VpcIds.SecurityGroupId,
})

const IPAddressSchema = Schema.Struct({
  /**
   * Allocation identifier if it was created before. NOT branded: the empty
   * string is the documented auto-allocate sentinel (`{ allocationId: '' }`),
   * so a brand here would type `''` as an allocation ID.
   */
  allocationId: Schema.String,
})

const PublicIPAddressSchema = Schema.Struct({
  /** Allocation identifier if it was created before (see `IPAddressSchema` — unbranded: `''` = auto-allocate). */
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
  subnetId: VpcIds.SubnetId,
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

// The arm shape, the exactly-one rule and the preemptible coupling are **shared** with the three other
// `pricing_model` messages (compute Instance, ai Job/Endpoint) — see
// `modules/resources/shared/pricing.schema.ts`. What stays here is the doc at the prop, because which
// prop the arm couples to, and what a change does to this resource, are facts about this resource.
export { PricingModelSchema, type PricingModel } from '../../shared/pricing.schema.ts'


/**
 * Shared-filesystem attachment. `AttachedFilesystemSpec` in the proto reuses the
 * disk attach modes (READ_ONLY/READ_WRITE) and requires both the mount tag and
 * the referenced filesystem (`oneof type` is required).
 */
const ExistingFilesystemSchema = Schema.Struct({
  id: Ids.FilesystemId,
})

const AttachedFilesystemSpecSchema = Schema.Struct({
  attachMode: AttachModeSchema,
  /** Device identifier used in the mount command inside the guest (max 37 chars). */
  mountTag: Schema.String.check(Validation.isValidMountTag),
  /** Attach an existing shared filesystem by ID. */
  existingFilesystem: ExistingFilesystemSchema,
})

/**
 * Host-passthrough local (NVMe) disks. Availability depends on platform, preset
 * and region; their content is not preserved across a stop/start.
 *
 * The proto's `oneof request` is required and `passthrough_group` is its only
 * arm, so the request object is mandatory whenever `localDisks` is set.
 */
const LocalDisksSpecSchema = Schema.Struct({
  passthroughGroup: Schema.Struct({
    /**
     * Proto: "Enabled only when this field is explicitly set" — `true` requests
     * the host's passthrough disks; `false` requests the group without disks.
     */
    requested: Schema.Boolean,
  }),
})

/**
 * The API rejects reservation IDs alongside the on-demand-only policy
 * (`It's an error to provide reservation_ids with policy = FORBID`).
 */
const reservationPolicyValid = Schema.makeFilter(
  (policy: Record<string, unknown>) => {
    if (policy.policy === 'FORBID' && Array.isArray(policy.reservationIds) && policy.reservationIds.length > 0) {
      return {
        path: ['reservationIds'],
        issue: 'reservationIds cannot be combined with policy "FORBID" (on-demand only) — use AUTO or STRICT',
      }
    }
    return undefined
  },
  { title: 'reservation policy' },
)

const ReservationPolicySchema = Schema.Struct({
  /**
   * AUTO (default) — try reservations, then any capacity block, then on-demand.
   * FORBID — on-demand only. STRICT — capacity blocks only, fail otherwise.
   */
  policy: Schema.Union([Schema.Literal('AUTO'), Schema.Literal('FORBID'), Schema.Literal('STRICT')]),
  /**
   * Capacity Block Groups to draw from, in priority order — each is a branded
   * `capacity/v1.CapacityBlockGroupId`.
   *
   * Obtain one from discovery rather than typing it:
   * `Nebius.capacity.action.ListCapacityBlockGroups({})` (or
   * `…GetCapacityBlockGroupByResourceAffinity({ region, fabric, platform })`,
   * which is the same triple the resource advisor reports).
   */
  reservationIds: Schema.Array(CapacityIds.CapacityBlockGroupId),
}).check(reservationPolicyValid)

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

/**
 * Service account to associate, or `''` for none.
 *
 * The API treats an empty `service_account_id` as "no service account" (the
 * field's default), and that sentinel is used for real: `instance.integration`
 * and `instance-minimal-online` deploy instances without one, and the VM-only
 * hosted programs read the id from the shipped env with a `''` fallback. A bare
 * `ServiceAccountId` cannot model it — its `serviceaccount-` refinement rejects
 * the empty string — so the field is a union.
 */
const InstanceServiceAccountId = Schema.Union([IamIds.ServiceAccountId, Schema.Literal('')])

// ---------------------------------------------------------------------------
// Instance Props (user input)
// ---------------------------------------------------------------------------

export const InstancePropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Service account ID to associate with this instance, or `''` for none. */
  serviceAccountId: InstanceServiceAccountId,
  /** Compute resources specification. */
  resources: ResourcesSpecSchema,
  /** Boot disk specification. */
  bootDisk: AttachedDiskSpecSchema,
  /** Additional data disks. */
  secondaryDisks: Schema.optional(Schema.Array(AttachedDiskSpecSchema)),
  /** Shared filesystems to attach. */
  filesystems: Schema.optional(Schema.Array(AttachedFilesystemSpecSchema)),
  /** Host-passthrough local disks (platform/preset dependent). */
  localDisks: Schema.optional(LocalDisksSpecSchema),
  /** Capacity reservation policy. */
  reservationPolicy: Schema.optional(ReservationPolicySchema),
  /** NVLink Instance Group to join (GPU/NVLink platforms). */
  nvlInstanceGroupId: Schema.optional(Ids.NVLInstanceGroupId),
  /** Network interfaces. Must have at least one. */
  networkInterfaces: Schema.Array(NetworkInterfaceSpecSchema),
  /** GPU cluster ID for InfiniBand interconnect. Only settable at creation. */
  gpuCluster: Schema.optional(Schema.Struct({ id: Ids.GpuClusterId })),
  /** Recovery policy on host failure. Default: RECOVER. */
  recoveryPolicy: Schema.optional(RecoveryPolicySchema),
  /** Set to create a preemptible VM (cheaper, can be stopped by platform). */
  preemptible: Schema.optional(PreemptibleSchema),
  /**
   * **`stopped: true` keeps the VM stopped; omitting it means "running"** — and the provider *starts* a
   * stopped VM to get there.
   *
   * That asymmetry is a measured API constraint, not a design preference. A proto3 `bool` has no presence,
   * so `stopped: false` **is** the field's default and is encoded as *absent* — and absent means "leave
   * unchanged" here (measured live 2026-09-24: an update carrying `stopped: false` was accepted,
   * `spec.stopped` still read `true`, and the instance stayed `STOPPED` for the whole 180 s wait). `true`
   * transmits; `false` never can.
   *
   * Two consequences the provider handles for you:
   *
   *  * **removing this prop starts the instance** — `reconcile` calls the service's `Start` RPC (the spec
   *    flag cannot express it), so `stopped: true` → omit is a working transition rather than a silent
   *    no-op;
   *  * **`false` is a plan-time error** (`Validation.trueOnly`), because a value that cannot leave the
   *    process must not look like a request. Before 2026-09-24 this prop accepted `false`, planned an
   *    update that could never converge, and — for a hosted instance whose bundle hash changed — left the
   *    VM stopped while the deploy waited for `RUNNING`.
   *
   * ⚠️ A **pricing** change is only accepted on a stopped instance, so the two interact: see
   * `pricingModelChangeRequiresStoppedInstance` below, which turns that API refusal into a plan-time error.
   */
  stopped: Schema.optional(
    Schema.Boolean.check(
      Validation.trueOnly(
        'stopped',
        'omitting it means "running" and the provider starts the VM through the `Start` RPC; `stopped: false` cannot be transmitted (a proto3 bool default is encoded as absent, and absent means leave-unchanged)',
      ),
    ),
  ),
  /**
   * How the VM is priced — `{ onDemand: true }`, `{ followsSpotPrice: true }` or
   * `{ spotPricingPolicy: { id } }` (arms and rules shared: `shared/pricing.schema.ts`). **Optional —
   * omitting it is the platform's default**, and the API does **not** materialize a default into `spec`
   * (measured live 2026-09-24: a create that pinned nothing echoed no pricing field at all, while the
   * empty *messages* around it — `gpuCluster`, `reservationPolicy`, `ipAddress` — were materialized).
   *
   * **A deliberate reshape**, documented here as AGENTS.md §"Naming" requires: the proto carries pricing
   * as three *flat* siblings on `InstanceSpec` (`on_demand`, `follows_spot_price`,
   * `spot_pricing_policy{id}`) and ts-proto emits a oneof as flat optional fields with no accessor, so
   * there is no `pricing` message to mirror — `hostedSpecInput` spreads it back through
   * `ResourceUtils.pricingModelFields`, the same reshape `storage/v1 transfer.stopCondition` makes. A
   * nested key would be dropped **silently** by `fromJSON`.
   *
   * The API enforces the `preemptible` coupling itself: measured live 2026-09-24, the spot arm on a
   * non-preemptible instance answers
   * `3 INVALID_ARGUMENT: spot-pricing-policy pricing requires a preemptible instance` — the rule
   * `pricingMatchesPreemptible` catches at plan time with a message naming the prop to drop.
   *
   * ⚠️ **A change is only accepted on a *stopped* instance** (all three measured live 2026-09-24):
   *
   *  * *introducing* the arm on a running instance is refused —
   *    `9 FAILED_PRECONDITION: spec fields [pricing_model] update could be done with stopped instance`;
   *  * **repeating** an already-set arm is accepted, so an unrelated field change (e.g. `hostname`) with
   *    the arm pinned converges normally — pinning does not poison later updates;
   *  * an update that **omits** it leaves it in place: absent means "leave unchanged", never "clear",
   *    which is why `pricingDrifted` only compares a *pinned* arm.
   *
   * So a user who wants to change the mode must stop the instance first (`stopped: true`) or recreate it —
   * the API's own message says so, which is why this is documented rather than planned as a replace
   * (recreating a VM to change a bid is a bigger hammer than stopping it).
   */
  pricing: Schema.optional(PricingModelSchema),
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
}).check(bootDiskImageRequired).check(pricingMatchesPresenceOnlyPreemptible('preemptible'))


// ---------------------------------------------------------------------------
// Plan-time errors
// ---------------------------------------------------------------------------

/**
 * A pricing change on a running instance: the API refuses it
 * (`9 FAILED_PRECONDITION: spec fields [pricing_model] update could be done with stopped instance`,
 * measured live 2026-09-24), and `diff` can see that the change needs a stopped VM — so it fails the plan
 * instead of letting the apply meet the refusal. `stopped: false` cannot express the workaround (a proto3
 * bool default is encoded as absent), which is why the message names `stopped: true` and the `Start` RPC.
 */
export class PricingChangeRequiresStoppedInstance extends Schema.TaggedError<PricingChangeRequiresStoppedInstance>()(
  'PricingChangeRequiresStoppedInstance',
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail
  }
}

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
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  serviceAccountId: InstanceServiceAccountId,
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
  /** @internal upload S3 access key id (cleanup creds). NOT branded: the S3 SID
   * *value* (`identity.awsAccessKeyId`), not the `AccessKey` resource ID. */
  hostedAccessKeyId: Schema.optional(Schema.String),
  /** @internal upload S3 secret access key (cleanup creds). */
  hostedSecretAccessKey: Schema.optional(Schema.String),
})

export type InstanceAttributes = typeof InstanceAttributesSchema.Type
