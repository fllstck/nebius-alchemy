export {
  NebiusServiceAccount as ServiceAccount,
  NebiusServiceAccountProvider as ServiceAccountProvider,
  type NebiusServiceAccount as ServiceAccountResource,
} from './service-account.ts'
export {
  ServiceAccountId,
  StaticKeyId,
  // Every other brand this version declares, so a consumer holding an id from *outside* a resource
  // output (an env var, a config file) can brand it at that boundary — `Nebius.iam.GroupId.make(…)`.
  // Reading ids off resource outputs needs none of this; constructing a prop from a literal does.
  // AGENTS.md §"Branded IDs" states this as an invariant; until 2026-09-23 only two of the thirteen
  // were reachable, which made `GroupMembership`/`AccessPermit`/`AuthPublicKey` props unconstructable
  // from outside the package — found while writing `examples/mk8s.ts`. `tests/package-exports.test.ts`
  // now enforces it.
  GroupId,
  FederationId,
  FederationCertificateId,
  AuthPublicKeyId,
  AccessPermitId,
  AccessPermitResourceId,
  GroupMembershipId,
  GroupMembershipMemberId,
  InvitationId,
  FederatedCredentialsId,
  TenantUserAccountId,
} from './ids.ts'
export {
  NebiusStaticKey as StaticKey,
  NebiusStaticKeyProvider as StaticKeyProvider,
  type NebiusStaticKey as StaticKeyResource,
} from './static-key.ts'
export {
  NebiusFederation as Federation,
  NebiusFederationProvider as FederationProvider,
  type NebiusFederation as FederationResource,
} from './federation.ts'
export {
  NebiusFederationCertificate as FederationCertificate,
  NebiusFederationCertificateProvider as FederationCertificateProvider,
  type NebiusFederationCertificate as FederationCertificateResource,
} from './federation-certificate.ts'
export {
  NebiusGroup as Group,
  NebiusGroupProvider as GroupProvider,
  type NebiusGroup as GroupResource,
} from './group.ts'
export {
  NebiusAuthPublicKey as AuthPublicKey,
  NebiusAuthPublicKeyProvider as AuthPublicKeyProvider,
  type NebiusAuthPublicKey as AuthPublicKeyResource,
} from './auth-public-key.ts'
export {
  NebiusFederatedCredentials as FederatedCredentials,
  NebiusFederatedCredentialsProvider as FederatedCredentialsProvider,
  type NebiusFederatedCredentials as FederatedCredentialsResource,
} from './federated-credentials.ts'
export {
  NebiusGroupMembership as GroupMembership,
  NebiusGroupMembershipProvider as GroupMembershipProvider,
  type NebiusGroupMembership as GroupMembershipResource,
} from './group-membership.ts'
export {
  NebiusAccessPermit as AccessPermit,
  NebiusAccessPermitProvider as AccessPermitProvider,
  type NebiusAccessPermit as AccessPermitResource,
} from './access-permit.ts'
export {
  NebiusInvitation as Invitation,
  NebiusInvitationProvider as InvitationProvider,
  type NebiusInvitation as InvitationResource,
} from './invitation.ts'
