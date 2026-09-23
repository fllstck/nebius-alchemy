// Managed Kubernetes (`mk8s`) — `v1` only.
//
// `mk8s/v1alpha1` is deliberately not implemented: its `ClusterSpec`/`NodeGroupSpec`
// are shape-identical to `v1`'s (compared field by field while planning), and every
// consumer in the ecosystem — the Nebius solutions library included — uses
// `nebius_mk8s_v1_*`. Same preview-duplicate convention that parked `vpc/v1alpha1`
// and `storage/v1alpha1`.
export { NebiusCluster as Cluster, NebiusClusterProvider as ClusterProvider, type NebiusCluster as ClusterResource } from './cluster.ts'
export { clusterSpecDrifted } from './cluster.ts'
export { ClusterId, NodeGroupId } from './ids.ts'
