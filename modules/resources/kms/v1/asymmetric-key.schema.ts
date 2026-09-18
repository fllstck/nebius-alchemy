import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// AsymmetricKey Props (user input)
// ---------------------------------------------------------------------------

export const AsymmetricAlgorithmSchema = Schema.Union([
  Schema.Literal('ECDSA_NIST_P256_SHA_256'),
  Schema.Literal('ECDSA_NIST_P384_SHA_384'),
  Schema.Literal('RSA_4096_ENC_OAEP_SHA_256'),
])

export const AsymmetricKeyPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optional(Schema.String),
  /** Cryptographic algorithm. Immutable after creation. */
  algorithm: Schema.optional(AsymmetricAlgorithmSchema),
})

export type AsymmetricKeyProps = typeof AsymmetricKeyPropsSchema.Type

export const validateAsymmetricKeyProps = Validation.makeValidateProps(AsymmetricKeyPropsSchema)

// ---------------------------------------------------------------------------
// AsymmetricKey Attributes (output)
// ---------------------------------------------------------------------------

export const AsymmetricKeyAttributesSchema = Schema.Struct({
  id: Ids.AsymmetricKeyId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  description: Schema.String,
  algorithm: AsymmetricAlgorithmSchema,
  state: Schema.String,
})

export type AsymmetricKeyAttributes = typeof AsymmetricKeyAttributesSchema.Type
