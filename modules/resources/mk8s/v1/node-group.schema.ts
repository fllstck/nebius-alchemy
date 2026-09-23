import * as Schema from 'effect/Schema'

import * as NebiusNodeGroupSchema from '../../../../schemas/nebius/mk8s/v1/node_group.ts'
import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamIds from '../../iam/v1/ids.ts'
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
 * `fixedNodeCount` is a **positive** integer.
 *
 * `0` is rejected for the reason every "required scalar" check exists in this
 * package: `fixedNodeCount` is an int64, and proto3 scalars have no presence, so `0`
 * and "field absent" are the same bytes on the wire. Accepting `0` would let a
 * caller write a prop whose value is never sent, and the API would answer with its own
 * default node count rather than an empty group.
 */
const fixedNodeCountValid = Schema.makeFilter((value: number) =>
  Number.isInteger(value) && value >= 1
    ? undefined
    : `fixedNodeCount must be a positive integer (got ${value}); 0 is indistinguishable from an omitted field on the wire (proto3 scalars have no presence)`,
)

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
// ## Scope: the minimal CPU arm (step 1 of N5's arm sequencing, 2026-09-23)
//
// This is the measured-working shape — `cpu-d3` + a preset + `fixedNodeCount` + an
// OS, over a subnet and a service account — and nothing else. The remaining
// `NodeTemplate` surface (`strategy`, `autoscaling`, `autoRepair`, GPU settings,
// filesystems, local disks, taints, node labels, `maxPods`, `preemptible`, NVLink,
// `reservationPolicy`) lands arm by arm, each with its own drift rows, because the
// template re-declares compute's concepts with its own types
// (`mk8s/v1/instance_template.ts` has its own `DiskSpec`/`ResourcesSpec`) and each
// arm has its own convergence hazard.
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
   */
  version: Schema.optional(Schema.String.check(versionValid)),
  /**
   * Number of nodes in the group. Mutually exclusive with `autoscaling` (which arrives
   * in the next arm); for now this is the only sizing prop, and the API requires
   * exactly one of the two.
   */
  fixedNodeCount: Schema.optional(Schema.Finite.check(fixedNodeCountValid)),
  /** What to run: OS, hardware, boot disk, network, user-data. */
  template: NodeGroupTemplateSchema,
})

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
