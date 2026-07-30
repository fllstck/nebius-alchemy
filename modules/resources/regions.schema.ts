import * as Schema from 'effect/Schema'

export const RegionSchema = Schema.Union([
  Schema.Literal('eu-north1'),
  Schema.Literal('eu-west1'),
  Schema.Literal('me-west1'),
  Schema.Literal('us-central1'),
  Schema.Literal('uk-south1'),
])
export type Region = typeof RegionSchema.Type
