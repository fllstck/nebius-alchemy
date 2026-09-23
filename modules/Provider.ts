import * as Layer from 'effect/Layer'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyAuth from 'alchemy/Auth'

import * as GrpcTransport from './api-client/GrpcTransport.ts'
import * as StorageGrpc from './api-client/storage.ts'
import * as IamGrpc from './api-client/iam.ts'
import * as VpcGrpc from './api-client/vpc.ts'
import * as ComputeGrpc from './api-client/compute.ts'
import * as DnsGrpc from './api-client/dns.ts'
import * as MysteryBoxGrpc from './api-client/mysterybox.ts'
import * as KmsGrpc from './api-client/kms.ts'
import * as QuotasGrpc from './api-client/quotas.ts'
import * as CapacityGrpc from './api-client/capacity.ts'
import * as AiGrpc from './api-client/ai.ts'
import * as Mk8sGrpc from './api-client/mk8s.ts'
import * as BucketResource from './resources/storage/v1/bucket.ts'
import * as TransferResource from './resources/storage/v1/transfer.ts'
import * as ProjectResource from './resources/iam/v2/project.ts'
import * as NetworkResource from './resources/vpc/v1/network.ts'
import * as SubnetResource from './resources/vpc/v1/subnet.ts'
import * as SecurityGroupResource from './resources/vpc/v1/security-group.ts'
import * as SecurityRuleResource from './resources/vpc/v1/security-rule.ts'
import * as RouteTableResource from './resources/vpc/v1/route-table.ts'
import * as RouteResource from './resources/vpc/v1/route.ts'
import * as PoolResource from './resources/vpc/v1/pool.ts'
import * as AllocationResource from './resources/vpc/v1/allocation.ts'
import * as DiskResource from './resources/compute/v1/disk.ts'
import * as ImageResource from './resources/compute/v1/image.ts'
import * as InstanceResource from './resources/compute/v1/instance.ts'
import * as FilesystemResource from './resources/compute/v1/filesystem.ts'
import * as DiskSnapshotResource from './resources/compute/v1/disk-snapshot.ts'
import * as GpuClusterResource from './resources/compute/v1/gpu-cluster.ts'
import * as Mk8sClusterResource from './resources/mk8s/v1/cluster.ts'
import * as NVLInstanceGroupResource from './resources/compute/v1/nvl-instance-group.ts'
import * as ZoneResource from './resources/dns/v1/zone.ts'
import * as RecordResource from './resources/dns/v1/record.ts'
import * as SecretResource from './resources/mysterybox/v1/secret.ts'
import * as SecretVersionResource from './resources/mysterybox/v1/secret-version.ts'
import * as SymmetricKeyResource from './resources/kms/v1/symmetric-key.ts'
import * as AsymmetricKeyResource from './resources/kms/v1/asymmetric-key.ts'
import * as QuotaAllowanceResource from './resources/quotas/v1/quota-allowance.ts'
import * as JobResource from './resources/ai/v1/job.ts'
import * as EndpointResource from './resources/ai/v1/endpoint.ts'
import * as ServiceAccountResource from './resources/iam/v1/service-account.ts'
import * as StaticKeyResource from './resources/iam/v1/static-key.ts'
import * as AccessKeyResource from './resources/iam/v2/access-key.ts'
import * as FederationResource from './resources/iam/v1/federation.ts'
import * as FederationCertificateResource from './resources/iam/v1/federation-certificate.ts'
import * as GroupResource from './resources/iam/v1/group.ts'
import * as AuthPublicKeyResource from './resources/iam/v1/auth-public-key.ts'
import * as FederatedCredentialsResource from './resources/iam/v1/federated-credentials.ts'
import * as GroupMembershipResource from './resources/iam/v1/group-membership.ts'
import * as AccessPermitResource from './resources/iam/v1/access-permit.ts'
import * as InvitationResource from './resources/iam/v1/invitation.ts'
import * as Credentials from './Credentials.ts'
import * as AuthProvider from './AuthProvider.ts'
import * as SaToken from './auth/sa-token.ts'
import * as SaBootstrap from './auth/sa-bootstrap.ts'
import * as ProjectConfig from './auth/project-config.ts'

export class Providers extends AlchemyProvider.ProviderCollection<Providers>()('Nebius') {}

const resources = AlchemyProvider.collection([
  BucketResource.NebiusBucket,
  TransferResource.NebiusTransfer,
  ProjectResource.NebiusProject,
  NetworkResource.NebiusNetwork,
  SubnetResource.NebiusSubnet,
  SecurityGroupResource.NebiusSecurityGroup,
  SecurityRuleResource.NebiusSecurityRule,
  RouteTableResource.NebiusRouteTable,
  RouteResource.NebiusRoute,
  PoolResource.NebiusPool,
  AllocationResource.NebiusAllocation,
  DiskResource.NebiusDisk,
  ImageResource.NebiusImage,
  InstanceResource.NebiusInstance,
  FilesystemResource.NebiusFilesystem,
  DiskSnapshotResource.NebiusDiskSnapshot,
  GpuClusterResource.NebiusGpuCluster,
  NVLInstanceGroupResource.NebiusNVLInstanceGroup,
  ZoneResource.NebiusZone,
  RecordResource.NebiusRecord,
  ServiceAccountResource.NebiusServiceAccount,
  StaticKeyResource.NebiusStaticKey,
  AccessKeyResource.NebiusAccessKey,
  FederationResource.NebiusFederation,
  FederationCertificateResource.NebiusFederationCertificate,
  GroupResource.NebiusGroup,
  AuthPublicKeyResource.NebiusAuthPublicKey,
  FederatedCredentialsResource.NebiusFederatedCredentials,
  GroupMembershipResource.NebiusGroupMembership,
  AccessPermitResource.NebiusAccessPermit,
  InvitationResource.NebiusInvitation,
  SecretResource.NebiusSecret,
  SecretVersionResource.NebiusSecretVersion,
  SymmetricKeyResource.NebiusSymmetricKey,
  AsymmetricKeyResource.NebiusAsymmetricKey,
  QuotaAllowanceResource.NebiusQuotaAllowance,
  JobResource.NebiusJob,
  EndpointResource.NebiusEndpoint,
])

export const providers = () =>
  Layer.effect(Providers, resources).pipe(
    Layer.provideMerge(BucketResource.NebiusBucketProvider),
    Layer.provideMerge(TransferResource.NebiusTransferProvider),
    Layer.provideMerge(ProjectResource.NebiusProjectProvider),
    Layer.provideMerge(NetworkResource.NebiusNetworkProvider),
    Layer.provideMerge(SubnetResource.NebiusSubnetProvider),
    Layer.provideMerge(SecurityGroupResource.NebiusSecurityGroupProvider),
    Layer.provideMerge(SecurityRuleResource.NebiusSecurityRuleProvider),
    Layer.provideMerge(RouteTableResource.NebiusRouteTableProvider),
    Layer.provideMerge(RouteResource.NebiusRouteProvider),
    Layer.provideMerge(PoolResource.NebiusPoolProvider),
    Layer.provideMerge(AllocationResource.NebiusAllocationProvider),
    Layer.provideMerge(DiskResource.NebiusDiskProvider),
    Layer.provideMerge(ImageResource.NebiusImageProvider),
    Layer.provideMerge(InstanceResource.NebiusInstanceProvider),
    Layer.provideMerge(FilesystemResource.NebiusFilesystemProvider),
    Layer.provideMerge(DiskSnapshotResource.NebiusDiskSnapshotProvider),
    Layer.provideMerge(GpuClusterResource.NebiusGpuClusterProvider),
    Layer.provideMerge(NVLInstanceGroupResource.NebiusNVLInstanceGroupProvider),
    Layer.provideMerge(ZoneResource.NebiusZoneProvider),
  ).pipe(
    Layer.provideMerge(RecordResource.NebiusRecordProvider),
    Layer.provideMerge(ServiceAccountResource.NebiusServiceAccountProvider),
    Layer.provideMerge(StaticKeyResource.NebiusStaticKeyProvider),
    Layer.provideMerge(AccessKeyResource.NebiusAccessKeyProvider),
    Layer.provideMerge(FederationResource.NebiusFederationProvider),
    Layer.provideMerge(FederationCertificateResource.NebiusFederationCertificateProvider),
    Layer.provideMerge(GroupResource.NebiusGroupProvider),
    Layer.provideMerge(AuthPublicKeyResource.NebiusAuthPublicKeyProvider),
    Layer.provideMerge(FederatedCredentialsResource.NebiusFederatedCredentialsProvider),
    Layer.provideMerge(GroupMembershipResource.NebiusGroupMembershipProvider),
  ).pipe(
    Layer.provideMerge(AccessPermitResource.NebiusAccessPermitProvider),
    Layer.provideMerge(InvitationResource.NebiusInvitationProvider),
    Layer.provideMerge(SecretResource.NebiusSecretProvider),
    Layer.provideMerge(SecretVersionResource.NebiusSecretVersionProvider),
    Layer.provideMerge(SymmetricKeyResource.NebiusSymmetricKeyProvider),
    Layer.provideMerge(AsymmetricKeyResource.NebiusAsymmetricKeyProvider),
    Layer.provideMerge(QuotaAllowanceResource.NebiusQuotaAllowanceProvider),
    Layer.provideMerge(JobResource.NebiusJobProvider),
    Layer.provideMerge(EndpointResource.NebiusEndpointProvider),
    Layer.provideMerge(StorageGrpc.StorageGrpcServiceLive),
    Layer.provideMerge(IamGrpc.IamGrpcServiceLive),
    Layer.provideMerge(VpcGrpc.VpcGrpcServiceLive),
    Layer.provideMerge(ComputeGrpc.ComputeGrpcServiceLive),
    Layer.provideMerge(DnsGrpc.DnsGrpcServiceLive),
    Layer.provideMerge(MysteryBoxGrpc.MysteryBoxGrpcServiceLive),
    Layer.provideMerge(KmsGrpc.KmsGrpcServiceLive),
    Layer.provideMerge(QuotasGrpc.QuotasGrpcServiceLive),
    Layer.provideMerge(CapacityGrpc.CapacityGrpcServiceLive),
    Layer.provideMerge(AiGrpc.AiGrpcServiceLive),
  ).pipe(
    // Split because `pipe` takes at most 20 functions — the chain above is exactly
    // at the limit (this is why the provider list is already split into two merges).
    Layer.provideMerge(Mk8sGrpc.Mk8sGrpcServiceLive),
    Layer.provideMerge(Mk8sClusterResource.NebiusClusterProvider),
  ).pipe(
    Layer.provideMerge(GrpcTransport.NebiusGrpcTransportLive),
    Layer.provideMerge(Credentials.fromAuthProvider),
    // Order matters: `provideMerge(that)` only satisfies SELF's requirements
    // with THAT's outputs — so NebiusAuth's ImplReq (SaTokenMinter,
    // SaBootstrap) must be merged AFTER NebiusAuth itself.
    Layer.provideMerge(AuthProvider.NebiusAuth),
    Layer.provideMerge(SaToken.SaTokenMinterLive),
    Layer.provideMerge(SaBootstrap.SaBootstrapLive),
  ).pipe(
    Layer.provideMerge(AlchemyAuth.ProfileStoreLive),
    // Must precede CredentialsStoreLive: its CredentialsStore requirement is
    // satisfied by that later merge (provideMerge only feeds SELF's
    // accumulated requirements, never the other way).
    Layer.provideMerge(ProjectConfig.NebiusProjectConfigProviderLive),
    Layer.provideMerge(AlchemyAuth.CredentialsStoreLive),
    Layer.orDie,
  )
