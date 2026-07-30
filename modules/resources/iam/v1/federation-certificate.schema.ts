import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as FederationSchema from './federation.schema.ts'

// ---------------------------------------------------------------------------
// FederationCertificate Props (user input)
// ---------------------------------------------------------------------------

export const FederationCertificatePropsSchema = Schema.Struct({
  parentId: FederationSchema.FederationId,
  name: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optional(Schema.String),
  /** PEM-encoded certificate data. Immutable after creation. */
  data: Schema.String.check(Validation.isPemFormat),
})

export type FederationCertificateProps = typeof FederationCertificatePropsSchema.Type

export const validateFederationCertificateProps = Validation.makeValidateProps(FederationCertificatePropsSchema)

// ---------------------------------------------------------------------------
// FederationCertificate Attributes (output)
// ---------------------------------------------------------------------------

export const FederationCertificateId = Schema.String.pipe(Schema.brand('FederationCertificateId'))
export type FederationCertificateId = typeof FederationCertificateId.Type

export const FederationCertificateAttributesSchema = Schema.Struct({
  id: FederationCertificateId,
  parentId: FederationSchema.FederationId,
  name: Schema.String,
  description: Schema.String,
  data: Schema.String,
  state: Schema.String,
  fingerprint: Schema.String,
  algorithm: Schema.String,
  keySize: Schema.Number,
  notBefore: Schema.optional(Schema.DateFromString),
  notAfter: Schema.optional(Schema.DateFromString),
})

export type FederationCertificateAttributes = typeof FederationCertificateAttributesSchema.Type
