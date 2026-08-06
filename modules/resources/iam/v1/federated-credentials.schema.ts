import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../v2/project.schema.ts'
import * as ServiceAccountSchema from './service-account.schema.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// FederatedCredentials Props (user input)
// ---------------------------------------------------------------------------

const OidcProviderSchema = Schema.Struct({
  issuerUrl: Schema.String.check(Validation.isValidUrl),
  jwkSetJson: Schema.optional(Schema.String),
})

export const FederatedCredentialsPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** OIDC provider configuration. */
  oidcProvider: OidcProviderSchema,
  /** The federated subject ID (from the "sub" claim of the JWT). */
  federatedSubjectId: Schema.String,
  /** The IAM subject (service account) that the federated subject impersonates. */
  subjectId: ServiceAccountSchema.ServiceAccountId,
})

export type FederatedCredentialsProps = typeof FederatedCredentialsPropsSchema.Type

export const validateFederatedCredentialsProps = Validation.makeValidateProps(FederatedCredentialsPropsSchema)

// ---------------------------------------------------------------------------
// FederatedCredentials Attributes (output)
// ---------------------------------------------------------------------------

export const FederatedCredentialsId = Schema.String.pipe(Schema.brand('FederatedCredentialsId'))
export type FederatedCredentialsId = typeof FederatedCredentialsId.Type

export const FederatedCredentialsAttributesSchema = Schema.Struct({
  id: FederatedCredentialsId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  oidcProvider: Schema.optional(OidcProviderSchema),
  federatedSubjectId: Schema.String,
  subjectId: ServiceAccountSchema.ServiceAccountId,
})

export type FederatedCredentialsAttributes = typeof FederatedCredentialsAttributesSchema.Type
