import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../v2/ids.ts'

// ---------------------------------------------------------------------------
// FederatedCredentials Props (user input)
// ---------------------------------------------------------------------------

const OidcProviderSchema = Schema.Struct({
  issuerUrl: Schema.String.check(Validation.isValidUrl),
  jwkSetJson: Schema.optional(Schema.String),
})

export const FederatedCredentialsPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** OIDC provider configuration. */
  oidcProvider: OidcProviderSchema,
  /**
   * The federated subject ID (from the "sub" claim of the JWT). NOT branded:
   * it identifies a subject in the *external* IdP, not a Nebius resource.
   */
  federatedSubjectId: Schema.String,
  /** The IAM subject (service account) that the federated subject impersonates. */
  subjectId: Ids.ServiceAccountId,
})

export type FederatedCredentialsProps = typeof FederatedCredentialsPropsSchema.Type

export const validateFederatedCredentialsProps = Validation.makeValidateProps(FederatedCredentialsPropsSchema)

// ---------------------------------------------------------------------------
// FederatedCredentials Attributes (output)
// ---------------------------------------------------------------------------

export const FederatedCredentialsAttributesSchema = Schema.Struct({
  id: Ids.FederatedCredentialsId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  oidcProvider: Schema.optional(OidcProviderSchema),
  /** See the props schema: an external IdP subject, deliberately unbranded. */
  federatedSubjectId: Schema.String,
  subjectId: Ids.ServiceAccountId,
})

export type FederatedCredentialsAttributes = typeof FederatedCredentialsAttributesSchema.Type
