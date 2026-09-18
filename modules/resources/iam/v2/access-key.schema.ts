import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamIds from '../v1/ids.ts'
import * as MysteryboxIds from '../../mysterybox/v1/ids.ts'

// ---------------------------------------------------------------------------
// SecretDeliveryMode — mirrors nebius.iam.v2.SecretDeliveryMode
// ---------------------------------------------------------------------------

export const SecretDeliveryMode = Schema.Union([
  Schema.Literal('INLINE'),
  Schema.Literal('MYSTERY_BOX'),
  Schema.Literal('EXPLICIT'),
])
export type SecretDeliveryMode = typeof SecretDeliveryMode.Type

// ---------------------------------------------------------------------------
// AccessKey Props (user input)
// ---------------------------------------------------------------------------

export const AccessKeyPropsSchema = Schema.Struct({
  serviceAccountId: IamIds.ServiceAccountId,
  description: Schema.optional(Schema.String),
  /** When the access key expires. If not set, the key does not expire. */
  expiresAt: Schema.optional(Schema.DateFromString),
  /**
   * How the one-time secret is delivered.
   * - `"INLINE"` (default): secret returned directly via getSecret.
   * - `"MYSTERY_BOX"`: secret lands in a MysteryBox, referenced by secretReferenceId.
   * - `"EXPLICIT"`: secret accessible only via explicit getSecret call.
   */
  secretDeliveryMode: Schema.optional(SecretDeliveryMode),
})

export type AccessKeyProps = typeof AccessKeyPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateAccessKeyProps = Validation.makeValidateProps(AccessKeyPropsSchema)

// ---------------------------------------------------------------------------
// AccessKey Attributes (output)
// ---------------------------------------------------------------------------

export const AccessKeyAttributesSchema = Schema.Struct({
  id: Ids.AccessKeyId,
  serviceAccountId: IamIds.ServiceAccountId,
  description: Schema.String,
  /**
   * The AWS-compatible access key ID (e.g. AKIAIOSFODNN7EXAMPLE). NOT branded:
   * this is the SID *value*, not the `AccessKey` resource ID (`Ids.AccessKeyId`).
   */
  awsAccessKeyId: Schema.String,
  /** The secret access key. Only available at creation time for INLINE/EXPLICIT delivery. */
  secretAccessKey: Schema.String,
  /** When MYSTERY_BOX delivery is used, references the MysteryBox secret containing the actual key material. */
  secretReferenceId: Schema.optional(MysteryboxIds.SecretId),
  state: Schema.String,
  createdAt: Schema.optional(Schema.DateFromString),
  expiresAt: Schema.optional(Schema.DateFromString),
  fingerprint: Schema.String,
  algorithm: Schema.String,
  keySize: Schema.Finite,
  secretDeliveryMode: SecretDeliveryMode,
})

export type AccessKeyAttributes = typeof AccessKeyAttributesSchema.Type
