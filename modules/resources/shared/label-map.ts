import * as Schema from 'effect/Schema'

/**
 * Label maps — and the one rule about them that is **service-dependent**.
 *
 * `metadata.labels` is the same field name everywhere in this package, but what the API does with an
 * **empty or blank key** is not, and the difference was measured rather than inferred
 * (`spikes/labels-empty-key-probe.ts`, live 2026-09-24, everything created and deleted in the same run):
 *
 * | field | key `''` | key `'  '` |
 * | `vpc/v1 Network.metadata.labels` | **accepted, and stored** (read back, `emptyKeyStored: true`) | **accepted and stored** |
 * | `compute/v1 Disk.metadata.labels` | **rejected** — `3 INVALID_ARGUMENT: metadata.labels is invalid` | accepted |
 * | Kubernetes Node labels (`mk8s NodeGroup.template.metadata.labels`) | not a valid Kubernetes label name | not a valid Kubernetes label name |
 *
 * So there is deliberately **no package-wide label schema**. A blanket filter would have been a regression
 * for VPC — it would reject a configuration the platform serves and stores, the same class of mistake the
 * `cloudInitUserData` note records — while leaving compute's refusal to surface at apply time with a message
 * that does **not** say which label is at fault. Two schemas, each applied only where it is measured:
 *
 *  * {@link computeLabelMap} for the compute service's metadata labels (the compute resources, and the
 *    managed disks an instance creates);
 *  * {@link kubernetesLabelMap} for maps that become **Kubernetes** object labels.
 *
 * Everything else keeps a bare `Schema.Record(Schema.String, Schema.String)` on purpose. The remaining
 * services that carry a `labels` prop — `iam/v1`, `iam/v2`, `storage/v1`, `dns/v1`, `kms/v1`,
 * `mysterybox/v1`, `quota`/`capacity`, `mk8s` Cluster/NodeGroup *resource* metadata, `ai/v1` — are
 * **unmeasured**: add a rule there only after measuring it with the probe above (one create + delete per
 * service; the arms and the controls that make them mean something are in that file).
 *
 * What is deliberately **not** encoded: key length, charset, and value rules. Those differ per service too,
 * their messages name the offending label, and a locally invented rule would be a guess. The measurements
 * above are the whole claim.
 */

/**
 * A label map for a **compute** resource or for a compute instance's metadata.
 *
 * Measured: compute refuses a strictly empty key with `3 INVALID_ARGUMENT: metadata.labels is invalid` —
 * a message that names neither the label nor the reason — while a blank (`'  '`) key is accepted. The
 * control arm (valid labels only) was accepted in the same run, so the refusal is about the key rather than
 * the request shape.
 *
 * The predicate is therefore `key === ''`, **not** `key.trim() === ''`: a `trim()` rule here would reject
 * what compute serves (see {@link kubernetesLabelMap} for the case where blank really is invalid).
 */
export const computeLabelMap = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter(
    (labels: Record<string, string>) =>
      Object.keys(labels).some((key) => key === '')
        ? 'labels must not contain an empty key: the compute service rejects the request with a bare "metadata.labels is invalid", naming neither the label nor the reason'
        : undefined,
    { title: 'compute label map (no empty key)' },
  ),
)

/**
 * A label map whose entries become **Kubernetes** object labels (`mk8s NodeGroup.template.metadata.labels`).
 *
 * Kubernetes has no label with an empty or blank name, so a key that is whitespace-only is as invalid as an
 * empty one — the rule is `key.trim() === ''`. This is the schema `mk8s` used to apply to *both* of its
 * template label maps; applying it to `instanceMetadata` (compute metadata, not a Kubernetes label) was
 * over-strict — measured: compute **accepts** a blank key, so the old rule rejected a configuration the
 * platform serves.
 */
export const kubernetesLabelMap = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter(
    (labels: Record<string, string>) =>
      Object.keys(labels).some((key) => key.trim().length === 0)
        ? 'label keys must not be empty or blank: Kubernetes has no such label name'
        : undefined,
    { title: 'Kubernetes label map (no empty or blank key)' },
  ),
)
