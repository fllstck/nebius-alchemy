import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'

// Canonical branded-ID home for `nebius.iam.v1`. One brand per schema entity;
// a field that references an entity must use that entity's brand (AGENTS.md
// §"Branded IDs — everywhere"). Polymorphic references get their own nominal
// brand rather than another resource's.

/** Branded ID for ServiceAccount resources. */
export const ServiceAccountId = Schema.String.check(
  Validation.isResourceId('serviceaccount-', 'ServiceAccount'),
).pipe(Schema.brand('ServiceAccountId'))
export type ServiceAccountId = typeof ServiceAccountId.Type

/** Branded ID for Group resources. */
export const GroupId = Schema.String.pipe(Schema.brand('GroupId'))
export type GroupId = typeof GroupId.Type

/** Branded ID for Federation resources. */
export const FederationId = Schema.String.pipe(Schema.brand('FederationId'))
export type FederationId = typeof FederationId.Type

/** Branded ID for FederationCertificate resources. */
export const FederationCertificateId = Schema.String.pipe(Schema.brand('FederationCertificateId'))
export type FederationCertificateId = typeof FederationCertificateId.Type

/** Branded ID for StaticKey resources. */
export const StaticKeyId = Schema.String.pipe(Schema.brand('StaticKeyId'))
export type StaticKeyId = typeof StaticKeyId.Type

/** Branded ID for AuthPublicKey resources. */
export const AuthPublicKeyId = Schema.String.pipe(Schema.brand('AuthPublicKeyId'))
export type AuthPublicKeyId = typeof AuthPublicKeyId.Type

/** Branded ID for AccessPermit resources. */
export const AccessPermitId = Schema.String.pipe(Schema.brand('AccessPermitId'))
export type AccessPermitId = typeof AccessPermitId.Type

/** Branded ID for GroupMembership resources. */
export const GroupMembershipId = Schema.String.pipe(Schema.brand('GroupMembershipId'))
export type GroupMembershipId = typeof GroupMembershipId.Type

/** Branded ID for Invitation resources. */
export const InvitationId = Schema.String.pipe(Schema.brand('InvitationId'))
export type InvitationId = typeof InvitationId.Type

/** Branded ID for FederatedCredentials resources. */
export const FederatedCredentialsId = Schema.String.pipe(Schema.brand('FederatedCredentialsId'))
export type FederatedCredentialsId = typeof FederatedCredentialsId.Type

/** Branded ID for TenantUserAccount resources (no provider yet — schema-only entity). */
export const TenantUserAccountId = Schema.String.pipe(Schema.brand('TenantUserAccountId'))
export type TenantUserAccountId = typeof TenantUserAccountId.Type

/**
 * Branded ID of an `AccessPermit` TARGET. Polymorphic by design: a permit can
 * be granted on any resource type (project, bucket, group, …), so this is a
 * nominal brand of its own rather than a union of the brands we happen to
 * implement — a union would be wrong-closed the moment a new resource type is
 * permitted. Precedent: `KmsKeyId` in `kms/v1/ids.ts`.
 *
 * A caller holding a concrete brand converts explicitly, which is the point:
 * `Output.map(bucket.id, AccessPermitResourceId.make)`.
 */
export const AccessPermitResourceId = Schema.String.pipe(Schema.brand('AccessPermitResourceId'))
export type AccessPermitResourceId = typeof AccessPermitResourceId.Type

/**
 * Member ID of a `GroupMembership`. Polymorphic over a **closed** set — the
 * proto's `GroupMemberKind.Kind` allows an ordinary/invited tenant user account
 * or a service account, nothing else — so this is a union of those brands
 * rather than a new nominal brand: a nominal brand would force an
 * `Output.map(…)` conversion at every call site that already holds a
 * `ServiceAccountId` (e.g. `host-identity.ts`), with no added safety.
 */
export const GroupMembershipMemberId = Schema.Union([TenantUserAccountId, ServiceAccountId])
export type GroupMembershipMemberId = typeof GroupMembershipMemberId.Type
