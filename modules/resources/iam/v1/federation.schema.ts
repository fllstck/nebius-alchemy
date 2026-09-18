import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../v2/ids.ts'

// ---------------------------------------------------------------------------
// Federation Props (user input)
// ---------------------------------------------------------------------------

const SamlSettingsSchema = Schema.Struct({
  idpIssuer: Schema.String.check(Validation.isValidUrl),
  ssoUrl: Schema.String.check(Validation.isValidUrl),
  forceAuthn: Schema.optional(Schema.Boolean),
})

export const FederationPropsSchema = Schema.Struct({
  /** Tenant ID. Defaults to NEBIUS_TENANT_ID. */
  parentId: Schema.optional(IamV2Ids.TenantId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  userAccountAutoCreation: Schema.optional(Schema.Boolean),
  samlSettings: SamlSettingsSchema,
})

export type FederationProps = typeof FederationPropsSchema.Type

export const validateFederationProps = Validation.makeValidateProps(FederationPropsSchema)

// ---------------------------------------------------------------------------
// Federation Attributes (output)
// ---------------------------------------------------------------------------

export const FederationAttributesSchema = Schema.Struct({
  id: Ids.FederationId,
  parentId: IamV2Ids.TenantId,
  name: Schema.String,
  userAccountAutoCreation: Schema.optional(Schema.Boolean),
  samlSettings: Schema.optional(SamlSettingsSchema),
  state: Schema.String,
  usersCount: Schema.Number,
  certificatesCount: Schema.Number,
})

export type FederationAttributes = typeof FederationAttributesSchema.Type
