import * as Layer from 'effect/Layer'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyAuth from 'alchemy/Auth'

import * as GrpcTransport from './api-client/GrpcTransport'
import * as StorageGrpc from './api-client/storage'
import * as IamGrpc from './api-client/iam'
import * as VpcGrpc from './api-client/vpc'
import * as ComputeGrpc from './api-client/compute'
import * as DnsGrpc from './api-client/dns'
import * as MysteryBoxGrpc from './api-client/mysterybox'
import * as KmsGrpc from './api-client/kms'
import * as QuotasGrpc from './api-client/quotas'
import * as AiGrpc from './api-client/ai'
import * as BucketResource from './resources/storage/v1/bucket'
import * as TransferResource from './resources/storage/v1/transfer'
import * as ProjectResource from './resources/iam/v2/project'
import * as NetworkResource from './resources/vpc/v1/network'
import * as SubnetResource from './resources/vpc/v1/subnet'
import * as SecurityGroupResource from './resources/vpc/v1/security-group'
import * as SecurityRuleResource from './resources/vpc/v1/security-rule'
import * as RouteTableResource from './resources/vpc/v1/route-table'
import * as RouteResource from './resources/vpc/v1/route'
import * as PoolResource from './resources/vpc/v1/pool'
import * as AllocationResource from './resources/vpc/v1/allocation'
import * as DiskResource from './resources/compute/v1/disk'
import * as ImageResource from './resources/compute/v1/image'
import * as InstanceResource from './resources/compute/v1/instance'
import * as FilesystemResource from './resources/compute/v1/filesystem'
import * as DiskSnapshotResource from './resources/compute/v1/disk-snapshot'
import * as ZoneResource from './resources/dns/v1/zone'
import * as RecordResource from './resources/dns/v1/record'
import * as SecretResource from './resources/mysterybox/v1/secret'
import * as SecretVersionResource from './resources/mysterybox/v1/secret-version'
import * as SymmetricKeyResource from './resources/kms/v1/symmetric-key'
import * as AsymmetricKeyResource from './resources/kms/v1/asymmetric-key'
import * as QuotaAllowanceResource from './resources/quotas/v1/quota-allowance'
import * as JobResource from './resources/ai/v1/job'
import * as EndpointResource from './resources/ai/v1/endpoint'
import * as ServiceAccountResource from './resources/iam/v1/service-account'
import * as StaticKeyResource from './resources/iam/v1/static-key'
import * as AccessKeyResource from './resources/iam/v2/access-key'
import * as FederationResource from './resources/iam/v1/federation'
import * as FederationCertificateResource from './resources/iam/v1/federation-certificate'
import * as GroupResource from './resources/iam/v1/group'
import * as AuthPublicKeyResource from './resources/iam/v1/auth-public-key'
import * as FederatedCredentialsResource from './resources/iam/v1/federated-credentials'
import * as GroupMembershipResource from './resources/iam/v1/group-membership'
import * as AccessPermitResource from './resources/iam/v1/access-permit'
import * as InvitationResource from './resources/iam/v1/invitation'
import * as Credentials from './Credentials'
import * as AuthProvider from './AuthProvider'

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
    Layer.provideMerge(AiGrpc.AiGrpcServiceLive),
  ).pipe(
    Layer.provideMerge(GrpcTransport.NebiusGrpcTransportLive),
    Layer.provideMerge(Credentials.fromAuthProvider),
    Layer.provideMerge(AuthProvider.NebiusAuth),
  ).pipe(
    Layer.provideMerge(AlchemyAuth.ProfileLive),
    Layer.provideMerge(AlchemyAuth.CredentialsStoreLive),
    Layer.orDie,
  )
