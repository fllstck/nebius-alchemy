import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// FederationCertificate Props (user input)
// ---------------------------------------------------------------------------

export const FederationCertificatePropsSchema = Schema.Struct({
  parentId: Ids.FederationId,
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

export const FederationCertificateAttributesSchema = Schema.Struct({
  id: Ids.FederationCertificateId,
  parentId: Ids.FederationId,
  name: Schema.String,
  description: Schema.String,
  data: Schema.String,
  state: Schema.String,
  fingerprint: Schema.String,
  algorithm: Schema.String,
  /**
   * Size of the certificate key in bits, as the platform reports it.
   *
   * int64 on the wire, and `toFriendlyAttributes` merges `spec.toJSON`/`status.toJSON` — ts-proto
   * renders int64s as decimal **strings**, so this is a string at runtime. Typed to match reality
   * (like `RecordAttributes.ttl`); parse it (`Number(...)`, `BigInt(...)`) if you need arithmetic.
   */
  keySize: Schema.String,
  notBefore: Schema.optional(Schema.DateFromString),
  notAfter: Schema.optional(Schema.DateFromString),
})

export type FederationCertificateAttributes = typeof FederationCertificateAttributesSchema.Type
