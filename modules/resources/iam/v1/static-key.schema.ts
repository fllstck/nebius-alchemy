import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// StaticKey Props (user input)
// ---------------------------------------------------------------------------

export const StaticKeyService = Schema.Union([
  Schema.Literal('OBSERVABILITY'),
  Schema.Literal('CONTAINER_REGISTRY'),
  Schema.Literal('AI_STUDIO'),
  Schema.Literal('TRACTO'),
  Schema.Literal('LINUX_IDENTITY'),
])

export const StaticKeyPropsSchema = Schema.Struct({
  serviceAccountId: Ids.ServiceAccountId,
  description: Schema.optional(Schema.String),
  service: Schema.optional(StaticKeyService),
  /** When the static key expires. If not set, the key does not expire. */
  expiresAt: Schema.optional(Schema.DateFromString),
})

export type StaticKeyProps = typeof StaticKeyPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateStaticKeyProps = Validation.makeValidateProps(StaticKeyPropsSchema)

// ---------------------------------------------------------------------------
// StaticKey Attributes (output)
// ---------------------------------------------------------------------------

export const StaticKeyAttributesSchema = Schema.Struct({
  id: Ids.StaticKeyId,
  serviceAccountId: Ids.ServiceAccountId,
  description: Schema.String,
  /** The one-time access key token. Only available at creation time (stored from issue response). */
  accessKey: Schema.String,
  /** The one-time secret key. Only available at creation time. */
  secretKey: Schema.String,
  createdAt: Schema.optional(Schema.DateFromString),
  expiresAt: Schema.optional(Schema.DateFromString),
  service: Schema.String,
  active: Schema.Boolean,
})

export type StaticKeyAttributes = typeof StaticKeyAttributesSchema.Type
