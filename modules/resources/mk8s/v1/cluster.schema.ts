import * as Schema from 'effect/Schema'

import * as NebiusClusterSchema from '../../../../schemas/nebius/mk8s/v1/cluster.ts'
import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'
import * as VpcIds from '../../vpc/v1/ids.ts'

// ---------------------------------------------------------------------------
// Domain validations
// ---------------------------------------------------------------------------

/**
 * Kubernetes version: `<major>.<minor>` only.
 *
 * The proto is explicit that no patch form is accepted yet ("For now only
 * acceptable format is `<major>.<minor>` like \"1.31\". Option for patch version
 * update will be added later"), so `1.35.0` is rejected here rather than by the
 * API. The message names the catalogue instead of listing versions: the available
 * set **moves** — measured 2026-09-23 it was 1.30–1.36, with 1.31 already
 * `deprecated` and past its end of life (2026-09-01) — so a hard-coded list in an
 * error message would rot.
 */
const versionValid = Schema.makeFilter((value: string) =>
  /^\d+\.\d+$/.test(value)
    ? undefined
    : `version must be "<major>.<minor>" (e.g. "1.35") — patch versions are not accepted yet; omit it to use the backend default, or list the current options with Nebius.capacity.action / \`nebius mk8s cluster list-control-plane-versions\``,
)

/**
 * `etcdClusterSize` — the set the API accepts.
 *
 * Measured indirectly (already `1`/`3`/`5`: the Nebius solutions library
 * validates exactly `contains([1, 3, 5], …)`), and `1` is **verified live**
 * (2026-09-23: a cluster created with 1 reached `RUNNING`). 3 is the platform
 * default and the smallest HA configuration, so this only ever has to catch
 * `2`/`4` from a user who assumed any odd number works.
 */
const etcdClusterSizeValid = Schema.makeFilter((value: number) =>
  Number.isInteger(value) && (value === 1 || value === 3 || value === 5)
    ? undefined
    : `etcdClusterSize must be 1, 3 or 5 (got ${value}); 1 is a single-instance non-HA control plane, 3 (the default) is the smallest highly-available one`,
)

/**
 * A presence-only switch: `true` enables, and there is no way to express "off".
 *
 * `AuditLogsSpec` and `Karpenter` are **empty messages** in the proto whose mere
 * presence enables the feature, and mk8s has **no `FieldMask`** (measured
 * 2026-09-23) — so an absent field means "leave unchanged", not "disable". A
 * `false` would therefore be a silent no-op, and the convergence doctrine prefers a
 * plan-time error to a silently-lost prop: the API cannot express it, so neither
 * can the props.
 */
const presenceOnly = (prop: string) =>
  Schema.makeFilter((value: boolean) =>
    value === true
      ? undefined
      : `${prop} can only be turned ON: the proto models it as an empty message (presence enables it) and this API has no FieldMask, so an absent field means "leave unchanged" — there is no way to disable it after creation, short of recreating the cluster`,
  )

/**
 * Service-ClusterIP CIDR — **deliberately not `Validation.isValidCIDR`**.
 *
 * `kubeNetwork.serviceCidrs` accepts either a full CIDR *or* a bare prefix length
 * ("If prefix length is specified, the CIDR block will be auto-allocated from the
 * network's available space", allowed range `/12`–`/28`), whereas every other
 * address field in this package rejects the prefix-only form — `isValidCIDR`
 * exists precisely to reject `"/24"` with *"Prefix-only CIDR … is not accepted by
 * the API"*. Reusing it here would reject the API's own documented input.
 *
 * Immutable after creation (see the provider's `diff`).
 */
const kubeServiceCidrValid = Schema.makeFilter((value: string) => {
  if (/^\/\d{1,2}$/.test(value)) {
    const prefix = Number(value.slice(1))
    return prefix >= 12 && prefix <= 28
      ? undefined
      : `serviceCidrs prefix length must be /12–/28 (got "${value}")`
  }
  // Delegate the full-CIDR case to the shared predicate — a `Schema.Filter` is not
  // callable, so `Validation.ipv4CidrIssue` is what makes reuse possible here instead
  // of a second copy of the octet rules that would drift from the first.
  return Validation.ipv4CidrIssue(value)
})

// ---------------------------------------------------------------------------
// Cluster Props (user input)
// ---------------------------------------------------------------------------

export const ClusterPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),

  /**
   * Desired Kubernetes version, `<major>.<minor>`.
   *
   * **Omit it** unless you have a reason not to — the Nebius solutions library
   * recommends the backend default (`k8s_version = null`), and the status reports
   * what was actually resolved. Pinning a version that later goes out of life is
   * the failure mode this prop invites, so {@link VersionValid} only checks the
   * shape; the catalogue is a live query, not a constant.
   */
  version: Schema.optional(Schema.String.check(versionValid)),

  /**
   * VPC subnet for the control plane — which is also the **default subnet for
   * every node group** in the cluster.
   *
   * **Immutable**: a change plans a replace. Measured 2026-09-23, attempting an
   * in-place change is not politely refused — the API answers the opaque
   * `13 INTERNAL: internal error` and nothing changes, which is exactly why the
   * replacement is planned here instead of left to apply time.
   */
  subnetId: VpcIds.SubnetId,

  /**
   * Number of etcd instances: `1`, `3` (default) or `5`. 3 is the smallest
   * "Highly Available" control plane — a 1-instance cluster is cheaper and is
   * what a throwaway test cluster wants, but it is not HA.
   */
  etcdClusterSize: Schema.optional(Schema.Finite.check(etcdClusterSizeValid)),

  /**
   * Public control-plane endpoint. **Presence is the switch** — the proto models
   * it as `ControlPlaneEndpointsSpec.public_endpoint`, an empty message whose
   * presence creates the endpoint, so `publicEndpoint: {}` (or with CIDRs) enables
   * it and omitting the prop leaves the API private.
   */
  publicEndpoint: Schema.optional(
    Schema.Struct({
      /**
       * Source CIDRs allowed to reach the public endpoint. Omitted or empty means
       * **unrestricted** ("If field is not set, or list is empty, it means that
       * access is not restricted at all") — so this is an allow-list to narrow,
       * not one to rely on for safety by default.
       */
      allowedCidrs: Schema.optional(Schema.Array(Schema.String.check(Validation.isValidCIDR))),
    }),
  ),

  /**
   * Push Kubernetes audit logs into Nebius service logs, where the console shows
   * them. Mapped from an **empty message** in the proto (`AuditLogsSpec`) plus
   * `[(field_behavior) = MEANINGFUL_EMPTY_VALUE]`, so `true` sends `{}` and
   * absent/`false` omits the field — a deliberate reshape of
   * "field present ⇒ enabled" into a boolean, documented here as AGENTS.md
   * requires.
   */
  auditLogs: Schema.optional(Schema.Boolean.check(presenceOnly('auditLogs'))),

  /**
   * Install Karpenter in the cluster (same empty-message→boolean reshape as
   * {@link auditLogs}).
   *
   * ⚠️ The API installs it as a Helm chart, so it "requires creation of at least
   * one CPU public node group" — a cross-resource requirement this provider
   * cannot check (node groups are separate resources, and a provider cannot see
   * its dependents), and the proto warns there is "no feature parity between
   * Karpenter node pools and public node groups".
   */
  karpenter: Schema.optional(Schema.Boolean.check(presenceOnly('karpenter'))),

  /**
   * CIDR blocks for Service ClusterIP allocation. Only one value is supported
   * today, and an empty value is treated as `["/16"]`.
   *
   * **Immutable**: a change plans a replace (the CLI omits this from `cluster
   * update`, and it is reserved inside the control-plane subnet at creation).
   */
  serviceCidrs: Schema.optional(Schema.Array(Schema.String.check(kubeServiceCidrValid))),
})

export type ClusterProps = typeof ClusterPropsSchema.Type

export const validateClusterProps = Validation.makeValidateProps(ClusterPropsSchema)

// ---------------------------------------------------------------------------
// Cluster Attributes (output)
// ---------------------------------------------------------------------------
//
// Hand-mapped rather than routed through `ResourceUtils.toFriendlyAttributes`,
// because flattening spec over status **collides on `version`**: the spec holds
// what was *requested* (absent when the backend default was used) while the status
// holds what is *running* (`1.35`), and both live at `controlPlane.version`. The
// generic helper would keep whichever spreads last, silently hiding the other.
// The mapper below reports both, under names that do not depend on spread order.
//
// It also keeps the int64 → decimal **string** rule explicit: the api-client hands
// back decoded protobuf (so `etcdClusterSize` is a `Long` there, and
// `status.strategy`-style fields are objects), while this module's attributes are
// the JSON-shaped view consumers read. See TASKS.md §NEXT UP item 5.

export const ClusterAttributesSchema = Schema.Struct({
  id: Ids.ClusterId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * The version **requested** in `spec` — absent when the cluster was created
   * without one (the recommended configuration, and the only case where the
   * backend picks).
   */
  requestedVersion: Schema.optional(Schema.String),
  /**
   * The version the control plane is **actually running** (`status`), e.g.
   * `1.35`. This is the one to read; `requestedVersion` is what was asked for.
   */
  version: Schema.optional(Schema.String),
  /** Control-plane subnet (immutable after creation). */
  subnetId: Schema.optional(VpcIds.SubnetId),
  /** etcd instance count, int64 on the wire → decimal **string** here. */
  etcdClusterSize: Schema.optional(Schema.String),
  /** `PROVISIONING` / `RUNNING` / `DELETING` (`STATE_UNSPECIFIED` maps to omitted). */
  state: Schema.optional(Schema.String),
  /**
   * Where the Kubernetes API answers. `privateEndpoint` is reachable from inside
   * the VPC; `publicEndpoint` only exists when the prop asked for one.
   */
  endpoints: Schema.optional(
    Schema.Struct({
      publicEndpoint: Schema.optional(Schema.String),
      privateEndpoint: Schema.optional(Schema.String),
    }),
  ),
  /**
   * PEM bundle of the cluster certificate authority, for TLS to the API endpoint.
   * Namespaced as `clusterCaCertificate` because it is the *cluster's* CA, not a
   * user certificate.
   */
  clusterCaCertificate: Schema.optional(Schema.String),
  /** An operation is in flight on the cluster. */
  reconciling: Schema.optional(Schema.Boolean),
})

export type ClusterAttributes = typeof ClusterAttributesSchema.Type

/**
 * Friendly attributes for one Cluster.
 *
 * `requestedVersion` is read from `spec`, `version` from `status` — the two are
 * deliberately distinct (see the note above the schema). The cluster's
 * `status.events` are **not** surfaced: they are transient operational
 * notifications (a freshly created cluster carries `WARN` entries on the way to
 * `RUNNING` — measured 2026-09-23), not identity, and the node-group equivalent
 * is where they are actually useful.
 */
export const toFriendlyAttributes = (raw: NebiusClusterSchema.Cluster): ClusterAttributes => {
  const spec = raw.spec?.controlPlane
  const status = raw.status
  const statusCp = status?.controlPlane
  const endpoints = statusCp?.endpoints

  return {
    id: Ids.ClusterId.make(raw.metadata?.id ?? ''),
    parentId: IamV2Ids.ProjectId.make(raw.metadata?.parentId ?? ''),
    name: raw.metadata?.name ?? '',
    labels: raw.metadata?.labels,
    requestedVersion: spec?.version ? spec.version : undefined,
    version: statusCp?.version ? statusCp.version : undefined,
    subnetId: spec?.subnetId ? VpcIds.SubnetId.make(spec.subnetId) : undefined,
    etcdClusterSize: spec?.etcdClusterSize === undefined ? undefined : spec.etcdClusterSize.toString(),
    state: status?.state === undefined ? undefined : NebiusClusterSchema.clusterStatus_StateToJSON(status.state),
    endpoints:
      endpoints === undefined
        ? undefined
        : {
            publicEndpoint: endpoints.publicEndpoint ? endpoints.publicEndpoint : undefined,
            privateEndpoint: endpoints.privateEndpoint ? endpoints.privateEndpoint : undefined,
          },
    clusterCaCertificate: statusCp?.auth?.clusterCaCertificate
      ? statusCp.auth.clusterCaCertificate
      : undefined,
    reconciling: status?.reconciling ?? false,
  }
}
