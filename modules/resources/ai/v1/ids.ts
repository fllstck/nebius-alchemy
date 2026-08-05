import * as Schema from 'effect/Schema'

/** Branded ID for Job resources. */
export const JobId = Schema.String.pipe(Schema.brand('JobId'))
export type JobId = typeof JobId.Type

/** Branded ID for Endpoint resources. */
export const EndpointId = Schema.String.pipe(Schema.brand('EndpointId'))
export type EndpointId = typeof EndpointId.Type
