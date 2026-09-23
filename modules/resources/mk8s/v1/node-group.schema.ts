import * as Schema from 'effect/Schema'

import * as NebiusNodeGroupSchema from '../../../../schemas/nebius/mk8s/v1/node_group.ts'
import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamIds from '../../iam/v1/ids.ts'
import * as ComputeIds from '../../compute/v1/ids.ts'
import * as CapacityIds from '../../capacity/v1/ids.ts'
import * as VpcIds from '../../vpc/v1/ids.ts'

// ---------------------------------------------------------------------------
// Domain validations
// ---------------------------------------------------------------------------

/**
 * Requested Kubernetes version: `<major>.<minor>`.
 *
 * Same rule as the Cluster's `version` (the shared predicate is
 * `Validation.isMajorMinorVersion`), same format — and a **deliberately different
 * message**: a node group inherits the cluster's *resolved* version when this is
 * omitted, so the authority to name here is the cluster, not the version catalogue.
 *
 * ⚠️ Do not confuse this with `status.version`, which is a different format
 * entirely: **measured live 2026-09-23** as `v1.36.3-nebius-node.75` — note the leading
 * `v`, which the plan of record (TASKS.md §N5) had recorded without it. Nothing shares a
 * parser between the two sides: `spec.version` is what was requested, `status.version` is
 * the node image actually running, and the cluster's own `status.controlPlane.version` is
 * a third format again (`1.36`, no `v` prefix).
 */
const versionValid = Schema.makeFilter((value: string) =>
  Validation.isMajorMinorVersion(value)
    ? undefined
    : `version must be "<major>.<minor>" (e.g. "1.35") — patch versions are not accepted yet; omit it to inherit the cluster's resolved version`,
)

/**
 * A positive, integer int64 count, for a field whose `0` means "absent".
 *
 * Same reasoning as every `≥ 1` check in this package: proto3 scalars have no presence, so `0`
 * and "field not sent" are the same bytes. A `0` accepted here would be a prop whose value is
 * never transmitted, and the API would keep its own value — the silent-no-op class.
 */
const positiveCount = (prop: string) =>
  Schema.makeFilter((value: number) =>
    Number.isInteger(value) && value >= 1
      ? undefined
      : `${prop} must be a positive integer (got ${value}); 0 is indistinguishable from an omitted field on the wire (proto3 scalars have no presence), so it cannot be set on an existing node group`,
  )

/**
 * `PercentOrCount.percent` is an **integer** percentage, despite the proto's "for example 5%"
 * prose: the wire field is an `int64`, so a fractional percent is not representable. The rounding
 * the proto documents happens later, on `percent × desired node count` (down for `maxUnavailable`,
 * up for `maxSurge`), and is the API's business, not ours.
 */
const percentValid = (prop: string) =>
  Schema.makeFilter((value: number) =>
    Number.isInteger(value) && value >= 1 && value <= 100
      ? undefined
      : `${prop} must be an integer percentage 1-100 (got ${value})`,
  )

/**
 * `PercentOrCount`, as the API's own two-valued union: a count **or** a percent.
 *
 * Modelled as one struct with a two-way filter rather than `Schema.Union([Struct{count},
 * Struct{percent}])`, and that is a **measured** decision (2026-09-23): Effect's `Union` tries
 * each member and *strips* the excess key, so `{ count: 1, percent: 20 }` decodes to
 * `{ count: 1 }` — the `percent` the caller wrote disappears without a word. The filter rejects
 * all three wrong shapes (both, neither, out of range) and names what was given.
 */
const percentOrCount = (prop: string) =>
  Schema.Struct({
    count: Schema.optional(Schema.Finite.check(positiveCount(`${prop}.count`))),
    percent: Schema.optional(Schema.Finite.check(percentValid(`${prop}.percent`))),
  }).check(
    Schema.makeFilter((value: { count?: number; percent?: number }) =>
      (value.count !== undefined) === (value.percent !== undefined)
        ? `set exactly one of ${prop}.count or ${prop}.percent (got count=${value.count}, percent=${value.percent}) — the API takes one, and rejects a 0/0 pair`
        : undefined,
    ),
  )

/**
 * A positive number of seconds for a `google.protobuf.Duration` field.
 *
 * `0` is rejected even where the proto gives it a meaning ("A value of 0 means no timeout"): a
 * zero duration encodes as an *absent* field, so sending it means "leave unchanged" — the platform
 * would keep the old value while the props say `0`, forever. A change *to* zero is therefore
 * unrepresentable in this API, and a plan-time error is the honest answer (AGENTS.md §Convergence).
 */
const positiveSeconds = (prop: string) =>
  Schema.makeFilter((value: number) =>
    Number.isInteger(value) && value >= 1
      ? undefined
      : `${prop} must be a positive whole number of seconds (got ${value}); 0 encodes as an absent field ("leave unchanged"), so it can never be set as a change`,
  )

/** Node condition status — `CONDITION_STATUS_UNSPECIFIED` is not offered (it is "the platform decides"). */
const conditionStatus = Schema.Union([
  Schema.Literal('TRUE'),
  Schema.Literal('FALSE'),
  Schema.Literal('UNKNOWN'),
])

/**
 * K8s taint effect. `EFFECT_UNSPECIFIED` is not offered — it is the wire's "the platform decides".
 *
 * ⚠️ The proto is explicit that taints are **not** rolled out: "change will not be propagated to
 * existing nodes, so will be applied only to Kubernetes Nodes created after the field change… you
 * will need to manually set them to existing nodes". Same stickiness class as
 * `cloudInitUserData`, documented rather than worked around.
 */
const taintEffect = Schema.Union([
  Schema.Literal('NO_EXECUTE'),
  Schema.Literal('NO_SCHEDULE'),
  Schema.Literal('PREFER_NO_SCHEDULE'),
])

/** Filesystem attach mode. `UNSPECIFIED` is not offered (the proto documents no default for it). */
const attachMode = Schema.Union([Schema.Literal('READ_ONLY'), Schema.Literal('READ_WRITE')])

/**
 * A Kubernetes node-label map, or the compute instance-metadata one.
 *
 * Keys and values must follow Kubernetes label syntax (the proto links the spec), and the platform
 * **ignores** any key containing `kubernetes.io` or `k8s.io` — so a `kubernetes.io/hostname` entry
 * here is accepted and silently dropped by the API, which is worth knowing before debugging it.
 * A map with an empty key is rejected by a filter on the whole map — **not** by
 * `Schema.Record(Schema.NonEmptyString, …)`, whose key schema *silently drops* the offending entry
 * (measured 2026-09-23: `{'': 'worker'}` decodes to `{}`, the same strip-don't-reject behaviour as
 * `Schema.Union` of structs — `agent-patterns/effect-schema.md`). The rest of the syntax (prefix,
 * 63-char limits, charset) is left to the API, whose message names the offending label.
 *
 * ⚠️ Like taints, label changes are **not** rolled out to existing nodes (measured live
 * 2026-09-24 — see the `cloudInitUserData` note on this same struct for the counter reading).
 */
const labelMap = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((labels: Record<string, string>) =>
    Object.keys(labels).some((key) => key.trim().length === 0)
      ? 'label keys must not be empty: Kubernetes has no such label, and an empty key would be silently dropped'
      : undefined,
  ),
)

/**
 * Passthrough local disks (`GB200`/`GB300`-class platforms) and what mk8s does with them.
 *
 * Both booleans can only be `true`: the proto enables passthrough "only when this field is
 * explicitly set", and `false` cannot be transmitted as a change (proto3 + no `FieldMask`). The two
 * `config` arms are mutually exclusive — `none` means "leave the disks alone" while
 * `kubeletEphemeral` (the platform's own default when `config` is unset) combines them into
 * kubelet's ephemeral storage — so setting both is rejected rather than resolved by field order.
 */
const LocalDisksSchema = Schema.Struct({
  passthroughGroup: Schema.optional(
    Schema.Struct({
      requested: Schema.Boolean.check(
        Validation.trueOnly(
          'template.localDisks.passthroughGroup.requested',
          'the proto enables passthrough only when the field is explicitly set, and a `false` cannot be transmitted (an absent field means "leave unchanged")',
        ),
      ),
    }),
  ),
  config: Schema.optional(
    Schema.Struct({
      /** "do nothing" — local disks are provisioned as on a regular compute instance. */
      none: Schema.optional(
        Schema.Boolean.check(
          Validation.trueOnly('template.localDisks.config.none', 'omit the arm instead of setting it to `false`'),
        ),
      ),
      /** Combine all local disks into one volume and use it as kubelet's ephemeral storage. */
      kubeletEphemeral: Schema.optional(
        Schema.Boolean.check(
          Validation.trueOnly(
            'template.localDisks.config.kubeletEphemeral',
            'omit the arm instead of setting it to `false`',
          ),
        ),
      ),
    }).check(
      Schema.makeFilter((value: { none?: boolean; kubeletEphemeral?: boolean }) =>
        value.none === true && value.kubeletEphemeral === true
          ? 'template.localDisks.config takes one arm: `none` (leave the disks alone) or `kubeletEphemeral` (combine them for kubelet), not both'
          : undefined,
      ),
    ),
  ),
}).check(
  Schema.makeFilter((value: { passthroughGroup?: unknown; config?: unknown }) =>
    value.passthroughGroup === undefined && value.config === undefined
      ? 'template.localDisks must set passthroughGroup or config — omit the block to leave local disks unmanaged'
      : undefined,
  ),
)

/**
 * Capacity reservations to spend, in priority order.
 *
 * `policy` deliberately **omits `AUTO`**: it is the proto's zero value, so it can neither be sent
 * (a zero enum encodes as an absent field → "leave unchanged") nor compared — and it is already
 * expressible by omitting `policy`, which is what "prefer my reservations, then pay-as-you-go"
 * means. `FORBID` and `STRICT` are the two values that actually *select* something, and the API
 * rejects `reservationIds` alongside `FORBID` ("It is an error to provide reservation_ids with
 * policy = FORBID"), which is a filter here rather than an apply-time surprise.
 *
 * The ids are branded `CapacityBlockGroupId`s — obtained from
 * `Nebius.capacity.action.ListCapacityBlockGroups`, which is why that discovery slice exists.
 */
const ReservationPolicySchema = Schema.Struct({
  policy: Schema.optional(Schema.Union([Schema.Literal('FORBID'), Schema.Literal('STRICT')])),
  reservationIds: Schema.optional(Schema.Array(CapacityIds.CapacityBlockGroupId)),
})
  .check(
    Schema.makeFilter((value: { policy?: string; reservationIds?: ReadonlyArray<unknown> }) =>
      value.policy === 'FORBID' && (value.reservationIds?.length ?? 0) > 0
        ? 'template.reservationPolicy: the API rejects reservationIds together with policy FORBID (FORBID means "on-demand capacity only")'
        : undefined,
    ),
  )
  .check(
    Schema.makeFilter((value: { policy?: string; reservationIds?: ReadonlyArray<unknown> }) =>
      value.policy === undefined && (value.reservationIds?.length ?? 0) === 0
        ? 'template.reservationPolicy must set policy (FORBID or STRICT) or reservationIds — omit the block for the platform default (AUTO)'
        : undefined,
    ),
  )

/**
 * GPU-related settings for a node group.
 *
 * `driversPreset` names a predefined set of drivers baked into the node image, and the catalogue is a
 * **live query** (it depends on the platform *and* the Kubernetes version) — the same authority as
 * `template.os`: `Nebius.mk8s.action.GetNodeGroupCompatibilityMatrix`. Omit it for a **driverless**
 * image, which is what a DRA-enabled group wants (the proto: "Leave empty for GPU nodes that do not
 * have preinstalled drivers, including DRA-enabled node groups").
 *
 * `dra` can only be `true`: it enables Dynamic Resource Allocation (the proto: it disables the legacy
 * NVIDIA device plugin for images that do carry drivers, and advertises RDMA through the managed DRANet
 * DaemonSet for groups attached to a Compute GPU cluster). A `false` is not a request — it is
 * indistinguishable from an absent field, and with no `FieldMask` absent means "leave unchanged".
 *
 * ⚠️ The Nebius solutions library additionally requires a **driverfull** image and no MIG/NUMA
 * partitioning for the GB300-class groups that also use `nvlink`. Those two are not checkable from here
 * (nothing in the API expresses a MIG/NUMA profile), so they stay guidance rather than filters.
 */
const GpuSettingsSchema = Schema.Struct({
  /** Driver preset name, e.g. `cuda12.8`. Omit for a driverless image (see the block note). */
  driversPreset: Schema.optional(Schema.String.check(Validation.isNonEmptyString('template.gpuSettings.driversPreset'))),
  /** Enable Dynamic Resource Allocation. **Presence is the switch** — see the block note. */
  dra: Schema.optional(Schema.Boolean.check(Validation.trueOnly('template.gpuSettings.dra', 'omit the field instead of setting it to `false`'))),
}).check(
  Schema.makeFilter((value: { driversPreset?: string; dra?: boolean }) =>
    value.driversPreset === undefined && value.dra !== true
      ? 'template.gpuSettings must set driversPreset or dra — omit the block entirely for a CPU node group'
      : undefined,
  ),
)

/**
 * The Compute GPU cluster to attach the nodes to (for RDMA / InfiniBand membership).
 *
 * The id is a branded `GpuClusterId`, obtained from a `Nebius.compute.GpuCluster` resource in the same
 * stack — which is how the fabric (a physical, Nebius-provided resource) reaches the node group.
 */
const GpuClusterSchema = Schema.Struct({ id: ComputeIds.GpuClusterId })

/**
 * NVLink node group membership (`GB200`/`GB300` racks).
 *
 * ⚠️ The generated CLI omits `--template-nvlink-nvl-instance-group-id` from `node-group update`, the
 * usual create-only tell — but the field is **not** create-only, which took two probes to establish:
 * `PreflightCheck` answered `requiresUserApproval: true` with a roll-out warning rather than an
 * immutability refusal, and `spikes/mk8s-nvlink-probe.ts` sent an update adding this field with a
 * well-formed, non-existent id and got `NotFound: nvl instance group not found by id
 * "computenvlinstancegroup-…"` — i.e. the API took the field and asked the compute service to resolve
 * the reference. So a change is a roll-out, not a replace, and it converges in place like every other
 * template field.
 *
 * The id must be `computenvlinstancegroup-…`-shaped (the API enforces that prefix; the brand in
 * `compute/v1/ids.ts` deliberately carries no refinement, so a mistyped prefix fails at apply time).
 * Unverified here: a *successful* change needs a real `NVLInstanceGroup`, which needs the `GB200`/`GB300`
 * entitlement this tenant lacks.
 */
const NVLinkSchema = Schema.Struct({ nvlInstanceGroupId: ComputeIds.NVLInstanceGroupId })

/**
 * The preconditions the Nebius solutions library encodes for `nvlink` groups, as far as they are
 * checkable from props: **fixed sizing** and **not preemptible**.
 *
 * Provenance matters here, so the messages say it: the solutions library is the only reference
 * implementation of NVLink node groups, and the proto independently notes the count "can be changed
 * manually at any time, except for a node group with NVLink" (so an autoscaler cannot own it either).
 * The remaining GB300 preconditions — driverfull image, no MIG/NUMA — are not expressible in these props
 * and are documented at {@link GpuSettingsSchema} instead of guessed at.
 */
const nvLinkPreconditions = Schema.makeFilter((props: {
  autoscaling?: unknown
  template?: { nvlink?: unknown; preemptible?: boolean }
}) => {
  if (props.template?.nvlink === undefined) return undefined
  if (props.autoscaling !== undefined)
    return 'template.nvlink requires fixed sizing: an NVLink node group cannot autoscale (the solutions library encodes this as a precondition, and the proto says the count cannot be changed for such a group)'
  if (props.template.preemptible === true)
    return 'template.nvlink requires non-preemptible nodes (the solutions library encodes this as a precondition; a reclaimed node would break the NVLink group)'
  return undefined
})

/**
 * `fixedNodeCount` and `autoscaling` are mutually exclusive **and** one of them is required.
 *
 * Both halves are the API's rule, not a preference: the proto documents the two as alternatives,
 * and a node group with neither has no size. That is also why "omit `fixedNodeCount`" is an
 * *invalid* props object — and why its convergence-table `omits` row had to go, with the
 * `autoscaling` row as the anti-loop probe instead (the harness rejects a required prop in
 * `omits`; it was right).
 */
const exactlyOneSizing = Schema.makeFilter((props: { fixedNodeCount?: number; autoscaling?: unknown }) => {
  const fixed = props.fixedNodeCount !== undefined
  const autoscaling = props.autoscaling !== undefined
  if (fixed && autoscaling)
    return 'fixedNodeCount and autoscaling are mutually exclusive — set one, not both (a fixed size or an autoscaled range)'
  if (!fixed && !autoscaling)
    return 'set either fixedNodeCount or autoscaling: a node group needs a size, and the API has no default for one'
  return undefined
})

/**
 * The roll-out strategy.
 *
 * Every field is optional, but an **empty block is rejected**: with no `FieldMask` an empty
 * message is indistinguishable from "leave unchanged", and `pinnedSpecDeepEqual` reads an empty
 * object as a *presence switch* (`publicIpAddress: {}` is exactly that) — which `strategy` is not.
 *
 * ⚠️ Read the **effective** values from `status.strategy`, never from here: with `strategy` omitted
 * the API answers its own defaults, and those are *migrating* — the proto documents
 * `maxUnavailable`/`maxSurge` moving from `{count: 1}`/`{count: 0}` and `drainTimeout` from `0` to
 * `10m` during Q3 2026, new clusters first and existing ones gradually. Nothing here compares
 * `status.strategy` (see `nodeGroupSpecDrifted`), which is what keeps that migration from looking
 * like drift.
 */
const StrategySchema = Schema.Struct({
  /** Nodes that may be unavailable at once during a roll-out. A percent rounds **down**. */
  maxUnavailable: Schema.optional(percentOrCount('strategy.maxUnavailable')),
  /** Extra nodes provisioned above the desired count during a roll-out. A percent rounds **up**. */
  maxSurge: Schema.optional(percentOrCount('strategy.maxSurge')),
  /**
   * Graceful-drain budget before pods are deleted outright.
   *
   * **Reshaped from `google.protobuf.Duration` to whole seconds** (the proto's `drainTimeout`), as
   * `storage/v1/transfer.interIterationIntervalSeconds` and
   * `kms/v1/symmetric-key.rotationPeriodSeconds` do: `Duration.fromJSON` accepts only the
   * `{seconds, nanos}` message form, so the canonical JSON string `"600s"` — what the CLI and the
   * API's renderings emit — would be silently dropped. The probe's measured effective value is
   * `600` (10m).
   */
  drainTimeoutSeconds: Schema.optional(Schema.Finite.check(positiveSeconds('strategy.drainTimeoutSeconds'))),
}).check(
  Schema.makeFilter((value: { maxUnavailable?: unknown; maxSurge?: unknown; drainTimeoutSeconds?: number }) =>
    value.maxUnavailable === undefined && value.maxSurge === undefined && value.drainTimeoutSeconds === undefined
      ? 'strategy must set at least one of maxUnavailable, maxSurge or drainTimeoutSeconds — omit the block to leave the platform values alone'
      : undefined,
  ),
)

/**
 * Auto-repair rules.
 *
 * Unlike `strategy`, an empty condition list is rejected on its own merits: the API's default rules
 * are what auto-repair *is* (the per-condition `disabled` flag is the override, and is deliberately
 * not exposed yet), so a block with no conditions asks for nothing.
 */
const AutoRepairSchema = Schema.Struct({
  conditions: Schema.Array(
    Schema.Struct({
      /** Node condition type, e.g. `Ready` / `MemoryPressure` — a free string (the set is Kubernetes's). */
      type: Schema.String.check(Validation.isNonEmptyString('autoRepair.conditions[].type')),
      /** The status that, held for `timeoutSeconds`, triggers a repair. */
      status: conditionStatus,
      /**
       * How long the condition must hold before the node is repaired.
       * **Reshaped from `Duration` to whole seconds** (see `strategy.drainTimeoutSeconds`).
       */
      timeoutSeconds: Schema.optional(Schema.Finite.check(positiveSeconds('autoRepair.conditions[].timeoutSeconds'))),
    }),
  ).check(
    Schema.makeFilter((value: ReadonlyArray<unknown>) =>
      value.length >= 1 ? undefined : 'autoRepair.conditions must list at least one condition',
    ),
  ),
})

/**
 * Boot-disk type. `UNSPECIFIED` is not offered: it is the wire's "the platform
 * decides", and every measured live shape names a type.
 */
const bootDiskType = Schema.Union([
  Schema.Literal('NETWORK_SSD'),
  Schema.Literal('NETWORK_HDD'),
  Schema.Literal('NETWORK_SSD_NON_REPLICATED'),
  Schema.Literal('NETWORK_SSD_IO_M3'),
])

// ---------------------------------------------------------------------------
// NodeGroup Props (user input)
// ---------------------------------------------------------------------------
//
// ## Scope: the CPU arms (arms 1 and 2 of N5's arm sequencing, 2026-09-23)
//
// Arm 1 is the measured-working shape — `cpu-d3` + a preset + a size + an OS, over a subnet and a
// service account — and arm 2 adds the three *behavioural* blocks: `autoscaling`, `strategy` and
// `autoRepair`. The rest of the `NodeTemplate` surface (GPU settings, filesystems, local disks,
// taints, node labels, `maxPods`, `preemptible`, NVLink, `reservationPolicy`) lands arm by arm, each
// with its own drift rows, because the template re-declares compute's concepts with its own types
// (`mk8s/v1/instance_template.ts` has its own `DiskSpec`/`ResourcesSpec`).
//
// The props therefore *omit* wire fields rather than zeroing them: the spec is built
// with `NodeGroupSpec.fromJSON` from exactly what is present (see `desiredSpec` in
// `node-group.ts`), which is what makes `pinnedSpecDeepEqual` the right drift check.

/**
 * A boot disk for every node in the group.
 *
 * Mirrors compute's disk rules (`compute/v1 DiskPropsSchema`), with one deliberate
 * difference: `sizeGibibytes` is **required** here.
 *
 *  * the four wire size fields (`sizeBytes`, `sizeKibibytes`, `sizeMebibytes`,
 *    `sizeGibibytes`) are the same value in different units — a boot disk is never
 *    sized in bytes — so only `sizeGibibytes` is exposed (the same reshape
 *    `compute/v1 Disk` already makes);
 *  * the ≥ 64 GiB floor is compute's measured platform rule (a smaller disk never
 *    reaches cloud-init, so provisioning hangs with no diagnostic — AGENTS.md
 *    §"Resource Lifecycle Details"). The mk8s write probe used exactly 64 GiB on
 *    `cpu-d3` (2026-09-23);
 *  * requiring the size rather than defaulting it is the decision: a default we
 *    invented would be *asserted* on every reconcile (`pinnedSpecDeepEqual` compares
 *    what we send), and omitting it would send the field's zero value — the
 *    `filesystem.blockSizeBytes` trap, where `spec` answers `0` and `status` answers
 *    the effective `4096`.
 */
const BootDiskSchema = Schema.Struct({
  /** Boot-disk size in gibibytes. The platform needs ≥ 64 GiB (see above). */
  sizeGibibytes: Schema.Finite.check(Validation.isValidBootDiskSizeGibibytes),
  /**
   * Block size in bytes: a power of two in 4096–131072.
   *
   * Optional, and **omitted from the request when omitted here** — the platform's
   * default applies, and `pinnedSpecDeepEqual` never compares a field we did not pin,
   * so the echo cannot loop. The solutions library always sets it explicitly; this
   * props surface follows the compute `Disk`/`Filesystem` shape instead (`blockSizeBytes?
   * → "use the platform default"`).
   */
  blockSizeBytes: Schema.optional(Schema.Finite.check(Validation.isValidBlockSize)),
  /** Disk type. Required — see {@link bootDiskType}. */
  type: bootDiskType,
})

const NetworkInterfaceSchema = Schema.Struct({
  /**
   * Subnet for this interface. **Omitted means the cluster's control-plane subnet**
   * ("By default Cluster control plane subnet_id used" — the proto, and a subnet in
   * the control plane's own network is required).
   */
  subnetId: Schema.optional(VpcIds.SubnetId),
  /**
   * Attach a public IPv4 address. **Presence is the switch** (the proto: "Set to empty
   * value, to enable it"), so `true` sends `{}` and there is no way to express "off"
   * — see `Validation.presenceOnly`.
   *
   * ⚠️ A public address is reachable from the internet and billed; it is what makes a
   * node group a "public" one (the configuration Karpenter's node pools require).
   */
  publicIpAddress: Schema.optional(
    Schema.Boolean.check(Validation.presenceOnly('template.networkInterfaces[].publicIpAddress', 'node group')),
  ),
})

/**
 * The node template — everything about the VMs this group provisions.
 *
 * `template` itself is **required**: it carries the OS, the hardware and the boot
 * disk, and every measured live shape sets it.
 */
const NodeGroupTemplateSchema = Schema.Struct({
  /**
   * OS image version, e.g. `ubuntu24.04`.
   *
   * Not validated against a list, because the supported set is a **live query** —
   * it depends on the Kubernetes version *and* the platform:
   * `Nebius.mk8s.action.GetNodeGroupCompatibilityMatrix` (or
   * `nebius mk8s node-group get-compatibility-matrix --cluster-kubernetes-version …
   * --platform …`) is the authority, and it moves (measured 2026-09-23: `1.31` +
   * `gpu-h200-sxm` → `ubuntu24.04`). A hard-coded list here would rot into rejecting
   * images the platform serves.
   */
  os: Schema.String.check(Validation.isNonEmptyString('template.os')),
  /**
   * Hardware for the nodes: `platform` plus an optional `preset`.
   *
   * `preset` is optional by design — the proto models it as a message field, so
   * absent means "the platform's default preset for this platform". No preset
   * catalogue is hard-coded here, for the same reason as {@link os} (and because
   * compute's own hard-coded preset list is already narrower than what the platform
   * accepts: `cpu-d3` + `2vcpu-8gb` is measured working for a node group while
   * compute's `presetMatchesPlatform` would reject it).
   */
  resources: Schema.Struct({
    /** Platform name, e.g. `cpu-d3`, `gpu-h200-sxm`. */
    platform: Schema.String.check(Validation.isNonEmptyString('template.resources.platform')),
    /** Preset name for the platform, e.g. `2vcpu-8gb`. Omitted → the platform default. */
    preset: Schema.optional(Schema.String.check(Validation.isNonEmptyString('template.resources.preset'))),
  }),
  /** Boot disk for each node. */
  bootDisk: BootDiskSchema,
  /**
   * Network interfaces, in order. Omitted entirely is a legal request (the platform
   * then places the node in the control-plane subnet with no public address).
   */
  networkInterfaces: Schema.optional(Schema.Array(NetworkInterfaceSchema)),
  /**
   * **Kubernetes node labels** (`metadata.labels` on the Node object).
   *
   * Not to be confused with {@link instanceMetadata}, which is the **compute instance's** own
   * metadata — two different maps in the same template, and a label written into the wrong one is
   * invisible from the other side.
   */
  metadata: Schema.optional(
    Schema.Struct({
      labels: labelMap,
    }),
  ),
  /**
   * **Compute instance metadata** labels, propagated onto the VMs of this group. Provider-managed
   * labels take precedence over user-provided ones here (the proto says so explicitly).
   */
  instanceMetadata: Schema.optional(
    Schema.Struct({
      labels: labelMap,
    }),
  ),
  /**
   * Kubernetes taints, applied to Nodes created after the change (existing nodes keep theirs — see
   * {@link taintEffect}).
   *
   * Measured live 2026-09-24: changing a taint's value was **accepted** and the new value landed in
   * `spec`, while `status.outdatedNodeCount` stayed `0` and `node`/`readyNodeCount` stayed `1` for
   * the whole 90 s window — the API does not roll the nodes out to apply it.
   */
  taints: Schema.optional(
    Schema.Array(
      Schema.Struct({
        /** Taint key, following Kubernetes syntax. */
        key: Schema.String.check(Validation.isNonEmptyString('template.taints[].key')),
        /** Taint value. **May be empty** (a taint without a value is legal and common). */
        value: Schema.String,
        effect: taintEffect,
      }),
    ),
  ),
  /**
   * Shared compute filesystems to attach to every node.
   *
   * The proto's only source is `existingFilesystem`, so it is required here: there is no way to
   * create a filesystem from a node group. `mountTag` is the device identifier the guest mounts,
   * capped at 37 characters (`Validation.isValidMountTag`).
   */
  filesystems: Schema.optional(
    Schema.Array(
      Schema.Struct({
        attachMode,
        mountTag: Schema.String.check(Validation.isValidMountTag),
        existingFilesystem: Schema.Struct({ id: ComputeIds.FilesystemId }),
      }),
    ),
  ),
  /**
   * Preemptible nodes. **Presence is the switch** (the proto: "Set to empty value to enable
   * preemptible nodes"), so `true` sends `{}` and `false` is a plan-time error — see
   * `Validation.presenceOnly`.
   */
  preemptible: Schema.optional(
    Schema.Boolean.check(Validation.presenceOnly('template.preemptible', 'node group')),
  ),
  /**
   * Passthrough local disks and how mk8s presents them (see {@link LocalDisksSchema}).
   */
  localDisks: Schema.optional(LocalDisksSchema),
  /**
   * Driver preset and DRA for GPU nodes (see {@link GpuSettingsSchema}).
   */
  gpuSettings: Schema.optional(GpuSettingsSchema),
  /**
   * The Compute GPU cluster whose RDMA fabric the nodes join (see {@link GpuClusterSchema}).
   */
  gpuCluster: Schema.optional(GpuClusterSchema),
  /**
   * NVLink rack membership (see {@link NVLinkSchema}).
   */
  nvlink: Schema.optional(NVLinkSchema),
  /**
   * Maximum pods per node. Omit it to let the platform choose (it documents `110`, and assigns the
   * pod CIDR from it) — the API **accepts** the omission, which is why this is optional despite the
   * proto marking it required. The documented default is **not written back into `spec`**: measured
   * live 2026-09-23, an omitted `maxPods` echoes as `0`.
   *
   * Removing the prop from a configuration that already pinned it is a no-op on the cloud side as
   * well: measured live 2026-09-24, an update whose spec omitted `maxPods` left the pinned `96` in
   * `spec` (an absent plain scalar means "leave unchanged", not "reset" — the exclusive
   * `fixedNodeCount` ⇄ `autoscaling` pair is the one place the API *does* clear the omitted side).
   */
  maxPods: Schema.optional(Schema.Finite.check(positiveCount('template.maxPods'))),
  /**
   * Which capacity reservations to spend, in priority order (see {@link ReservationPolicySchema}).
   */
  reservationPolicy: Schema.optional(ReservationPolicySchema),
  /**
   * The service account whose credentials are available on the nodes — for the Nebius
   * CLI/API and for container-registry pulls. It needs
   * `resource.serviceaccount.issueAccessToken`.
   */
  serviceAccountId: IamIds.ServiceAccountId,
  /**
   * cloud-init user-data, as the raw string (the same shape the compute `Instance`
   * exposes, so the same YAML works for both).
   *
   * **Required and non-empty, but the SSH key inside it is not validated.** The proto
   * says it "should contain at least one SSH key", and the Nebius solutions library
   * enforces that — the *API* does not: the write probe (2026-09-23) created a
   * `RUNNING` node group with `'#cloud-config\n'` and no key at all. Rejecting a
   * key-less payload here would reject a configuration the platform demonstrably
   * serves, so this documents the consequence instead: without a key there is no SSH
   * path into a node, which is the only way to debug a node that never joins.
   *
   * Empty is rejected because a proto3 scalar cannot distinguish `""` from absent —
   * see `Validation.isNonEmptyString`. A composing `sshPublicKey` prop is a possible
   * later addition (it would then own its own merge/roll-out semantics).
   *
   * ⚠️ **A change converges in `spec` but never reaches running nodes.** Measured live 2026-09-24
   * (`spikes/mk8s-rollout-probe.ts`): an update that changed this string was accepted and the new
   * value landed in `spec.template.cloudInitUserData` (echo length 31 → 46), while
   * `status.outdatedNodeCount` stayed `0` and `node`/`readyNodeCount` stayed `1` for the full 180 s
   * window. So the platform treats new user-data exactly like `taints` and `metadata.labels` — the
   * operator rolls out for *infrastructure* changes (platform, preset, os, version), not for this
   * one, and only freshly created nodes ever run it. To apply it to the nodes you have, change
   * something the platform does roll out for, or recreate the group; a failed edit here is silent,
   * which is the reason this paragraph exists.
   */
  cloudInitUserData: Schema.String.check(Validation.isNonEmptyString('template.cloudInitUserData')),
})

export const NodeGroupPropsSchema = Schema.Struct({
  /**
   * The cluster this group belongs to — `NodeGroup`'s parent is a **Cluster**, not
   * the project, so an id is only meaningful with its cluster (and a cluster's
   * deletion cascades to its node groups).
   */
  parentId: Ids.ClusterId,
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * Kubernetes version for the nodes, `<major>.<minor>`.
   *
   * **Omit it** to inherit the cluster's resolved version (measured: a node group
   * created without one came up on the cluster's own version). Pinning a version the
   * node images do not carry is rejected by the compatibility matrix, which is a live
   * query, not a constant.
   *
   * ⚠️ Omitting it on an **existing** group does not un-pin it: measured live 2026-09-24, a group
   * created with `spec.version = "1.35"` still echoed `"1.35"` after an update whose spec omitted
   * `version`. Removing this prop from a configuration therefore leaves the pinned version in the
   * cloud — an absent plain scalar means "leave unchanged" (see the same measurement on
   * `template.maxPods`).
   */
  version: Schema.optional(Schema.String.check(versionValid)),
  /**
   * Number of nodes in the group. **Mutually exclusive with `autoscaling`**, and one of the two
   * must be set.
   */
  fixedNodeCount: Schema.optional(Schema.Finite.check(positiveCount('fixedNodeCount'))),
  /**
   * Let the Kubernetes Cluster Autoscaler size the group between `minNodeCount` and
   * `maxNodeCount` (mutually exclusive with `fixedNodeCount`).
   *
   * Both bounds are positive: a `0` cannot be transmitted as a change (proto3), so
   * "scale to zero" is not expressible as an *update* here — a plan-time error beats a prop whose
   * value silently never leaves.
   */
  autoscaling: Schema.optional(
    Schema.Struct({
      /** Lower bound for the autoscaler. Positive — see the note on the block. */
      minNodeCount: Schema.Finite.check(positiveCount('autoscaling.minNodeCount')),
      /** Upper bound for the autoscaler. Positive, and ≥ `minNodeCount`. */
      maxNodeCount: Schema.Finite.check(positiveCount('autoscaling.maxNodeCount')),
    }).check(
      Schema.makeFilter((value: { minNodeCount: number; maxNodeCount: number }) =>
        value.maxNodeCount >= value.minNodeCount
          ? undefined
          : `autoscaling.maxNodeCount must be >= minNodeCount (got max=${value.maxNodeCount}, min=${value.minNodeCount})`,
      ),
    ),
  ),
  /**
   * How a roll-out replaces nodes (unavailable count, surge, drain timeout).
   *
   * Omit the block to leave the platform's values alone — and read the **effective** ones from
   * the node group's `status.strategy`, which is where the API reports them (they are also
   * migrating during Q3 2026; see {@link StrategySchema}).
   */
  strategy: Schema.optional(StrategySchema),
  /** Which node conditions, held for how long, trigger a repair. */
  autoRepair: Schema.optional(AutoRepairSchema),
  /** What to run: OS, hardware, boot disk, network, cloud-init, GPU/NVLink placement. */
  template: NodeGroupTemplateSchema,
})
  .check(exactlyOneSizing)
  .check(nvLinkPreconditions)

export type NodeGroupProps = typeof NodeGroupPropsSchema.Type

export const validateNodeGroupProps = Validation.makeValidateProps(NodeGroupPropsSchema)

// ---------------------------------------------------------------------------
// NodeGroup Attributes (output)
// ---------------------------------------------------------------------------
//
// Hand-mapped, like the Cluster's: `spec` and `status` both carry a `version` and the
// generic `toFriendlyAttributes` helper would keep whichever spreads last, hiding the
// one the caller actually needs to read.
//
// int64 → decimal **string** throughout, because `toJSON` renders them that way and a
// `Schema.Finite` on an int64 attribute is a type that lies (AGENTS.md §"Resource
// Lifecycle Details"). Note the asymmetry with the api-client: *there* the values are
// `Long` objects (decoded protobuf), which is why this mapper converts explicitly.

export const NodeGroupAttributesSchema = Schema.Struct({
  id: Ids.NodeGroupId,
  /** The parent **cluster** id. */
  parentId: Ids.ClusterId,
  name: Schema.String,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The version **requested** in `spec` — absent when the group inherited the cluster's. */
  requestedVersion: Schema.optional(Schema.String),
  /**
   * The version the nodes actually run (`status.version`), in the long
   * `v<major>.<minor>.<patch>-nebius-node.<infra_version>` form — measured live 2026-09-23
   * as `v1.36.3-nebius-node.75` (the `v` *is* part of it). Not comparable with
   * {@link requestedVersion}; see the note on `versionValid`.
   */
  version: Schema.optional(Schema.String),
  /** Requested node count (`spec.fixedNodeCount`), int64 → decimal **string**. */
  fixedNodeCount: Schema.optional(Schema.String),
  /** Desired total node count right now (fixed count, or the autoscaler's current target). */
  targetNodeCount: Schema.optional(Schema.String),
  /** Nodes currently in the group, ready and not ready. */
  nodeCount: Schema.optional(Schema.String),
  /** Nodes that joined the cluster and are ready to serve workloads. */
  readyNodeCount: Schema.optional(Schema.String),
  /** Nodes whose configuration is outdated and which a roll-out will replace. */
  outdatedNodeCount: Schema.optional(Schema.String),
  /** `PROVISIONING` / `RUNNING` / `DELETING` (`STATE_UNSPECIFIED` maps to omitted). */
  state: Schema.optional(Schema.String),
  /** An operation is in flight on the node group. */
  reconciling: Schema.optional(Schema.Boolean),
})

export type NodeGroupAttributes = typeof NodeGroupAttributesSchema.Type

const longToString = (value: { toString(): string } | undefined): string | undefined =>
  value === undefined ? undefined : value.toString()

/**
 * Friendly attributes for one NodeGroup.
 *
 * `requestedVersion` is read from `spec`, `version` from `status`; the counts are the
 * platform's view of the group's progress and are the useful signal while a roll-out
 * is in flight (`outdatedNodeCount` is what a user-data change shows up in — see
 * TASKS.md §N5, probe 2).
 */
export const toFriendlyAttributes = (raw: NebiusNodeGroupSchema.NodeGroup): NodeGroupAttributes => {
  const spec = raw.spec
  const status = raw.status

  return {
    id: Ids.NodeGroupId.make(raw.metadata?.id ?? ''),
    parentId: Ids.ClusterId.make(raw.metadata?.parentId ?? ''),
    name: raw.metadata?.name ?? '',
    labels: raw.metadata?.labels,
    requestedVersion: spec?.version ? spec.version : undefined,
    version: status?.version ? status.version : undefined,
    fixedNodeCount: longToString(spec?.fixedNodeCount),
    targetNodeCount: longToString(status?.targetNodeCount),
    nodeCount: longToString(status?.nodeCount),
    readyNodeCount: longToString(status?.readyNodeCount),
    outdatedNodeCount: longToString(status?.outdatedNodeCount),
    state:
      status?.state === undefined
        ? undefined
        : NebiusNodeGroupSchema.nodeGroupStatus_StateToJSON(status.state),
    reconciling: status?.reconciling ?? false,
  }
}
