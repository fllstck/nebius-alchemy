import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../v2/ids.ts'

// ---------------------------------------------------------------------------
// AuthPublicKey Props (user input)
// ---------------------------------------------------------------------------

export const AuthPublicKeyPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The account this key belongs to. Immutable after creation. */
  accountId: Ids.ServiceAccountId,
  description: Schema.optional(Schema.String),
  /** When the key expires. Immutable after creation. */
  expiresAt: Schema.optional(Schema.DateFromString),
  /** PEM-encoded public key data. Immutable after creation. */
  data: Schema.String.check(Validation.isPemFormat),
})

export type AuthPublicKeyProps = typeof AuthPublicKeyPropsSchema.Type

export const validateAuthPublicKeyProps = Validation.makeValidateProps(AuthPublicKeyPropsSchema)

// ---------------------------------------------------------------------------
// AuthPublicKey Attributes (output)
// ---------------------------------------------------------------------------

export const AuthPublicKeyAttributesSchema = Schema.Struct({
  id: Ids.AuthPublicKeyId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  accountId: Ids.ServiceAccountId,
  description: Schema.String,
  data: Schema.String,
  expiresAt: Schema.optional(Schema.DateFromString),
  state: Schema.String,
  fingerprint: Schema.String,
  algorithm: Schema.String,
  keySize: Schema.Finite,
})

export type AuthPublicKeyAttributes = typeof AuthPublicKeyAttributesSchema.Type
