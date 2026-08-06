import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../v2/project.schema.ts'
import * as ServiceAccountSchema from './service-account.schema.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// AuthPublicKey Props (user input)
// ---------------------------------------------------------------------------

export const AuthPublicKeyPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The account this key belongs to. Immutable after creation. */
  accountId: ServiceAccountSchema.ServiceAccountId,
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

export const AuthPublicKeyId = Schema.String.pipe(Schema.brand('AuthPublicKeyId'))
export type AuthPublicKeyId = typeof AuthPublicKeyId.Type

export const AuthPublicKeyAttributesSchema = Schema.Struct({
  id: AuthPublicKeyId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  accountId: ServiceAccountSchema.ServiceAccountId,
  description: Schema.String,
  data: Schema.String,
  expiresAt: Schema.optional(Schema.DateFromString),
  state: Schema.String,
  fingerprint: Schema.String,
  algorithm: Schema.String,
  keySize: Schema.Finite,
})

export type AuthPublicKeyAttributes = typeof AuthPublicKeyAttributesSchema.Type
