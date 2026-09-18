import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'

// ---------------------------------------------------------------------------
// Record Props (user input)
// ---------------------------------------------------------------------------

const RecordTypeSchema = Schema.Union([
  Schema.Literal('A'),
  Schema.Literal('AAAA'),
  Schema.Literal('PTR'),
  Schema.Literal('CNAME'),
  Schema.Literal('MX'),
  Schema.Literal('TXT'),
  Schema.Literal('SRV'),
  Schema.Literal('NS'),
  Schema.Literal('CAA'),
])

export const RecordPropsSchema = Schema.Struct({
  /** Parent zone ID. */
  parentId: Ids.ZoneId,
  /** Zone-relative name, e.g. "www" or "@" for apex. */
  relativeName: Schema.String,
  /** Record type. */
  type: RecordTypeSchema,
  /** Record TTL in seconds. Default: 600. */
  ttl: Schema.optional(Schema.Finite),
  /** Record data in presentation (zonefile) format. */
  data: Schema.String,
  /** Protect this record from accidental deletion. */
  deletionProtection: Schema.optional(Schema.Boolean),
})

export type RecordProps = typeof RecordPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateRecordProps = Validation.makeValidateProps(RecordPropsSchema)

// ---------------------------------------------------------------------------
// Record Attributes (output)
// ---------------------------------------------------------------------------

export const RecordAttributesSchema = Schema.Struct({
  id: Ids.RecordId,
  parentId: Ids.ZoneId,
  name: Schema.String,
  relativeName: Schema.optional(Schema.String),
  type: RecordTypeSchema,
  ttl: Schema.optional(Schema.String),
  data: Schema.String,
  effectiveFqdn: Schema.optional(Schema.String),
})

export type RecordAttributes = typeof RecordAttributesSchema.Type
