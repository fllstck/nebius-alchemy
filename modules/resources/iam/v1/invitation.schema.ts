import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../v2/ids.ts'

// ---------------------------------------------------------------------------
// Invitation Props (user input)
// ---------------------------------------------------------------------------

export const InvitationPropsSchema = Schema.Struct({
  /** Tenant ID. Defaults to NEBIUS_TENANT_ID. */
  parentId: Schema.optional(IamV2Ids.TenantId),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optional(Schema.String),
  /** Email address to send the invitation to. */
  email: Schema.String.check(Validation.isValidEmail),
  /** If true, don't send the invitation on creation — caller uses Resend later. */
  noSend: Schema.optional(Schema.Boolean),
  /** How long the invitation remains valid, in seconds. If omitted, the service default is used. */
  expiresInSeconds: Schema.optional(Schema.Finite),
})

export type InvitationProps = typeof InvitationPropsSchema.Type

export const validateInvitationProps = Validation.makeValidateProps(InvitationPropsSchema)

// ---------------------------------------------------------------------------
// Invitation Attributes (output)
// ---------------------------------------------------------------------------

export const InvitationAttributesSchema = Schema.Struct({
  id: Ids.InvitationId,
  parentId: IamV2Ids.TenantId,
  description: Schema.String,
  email: Schema.String,
  /** The tenant user account created by the invitation. */
  tenantUserAccountId: Schema.optional(Ids.TenantUserAccountId),
  expiresAt: Schema.optional(Schema.DateFromString),
  state: Schema.String,
})

export type InvitationAttributes = typeof InvitationAttributesSchema.Type
