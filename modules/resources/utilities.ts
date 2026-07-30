/**
 * Convert a protobuf resource (metadata + spec + status) into friendly
 * attributes by merging raw fields with their JSON-serialized equivalents.
 *
 * The raw spread ensures no fields are dropped. The JSON overlay converts
 * Long → string and enum → string. Optional overrides handle edge cases
 * like Long.ZERO which `toJSON` conditionally omits.
 */
export const toFriendlyAttributes = <T>({
  rawResource,
  resourceSchema,
  overrides,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawResource: { metadata?: any; spec?: any; status?: any }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resourceSchema: { toJSON: (resource: any) => any }
  overrides?: Record<string, unknown>
}): T => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const safeResource = resourceSchema.toJSON(rawResource)
  return {
    ...rawResource.metadata,
    ...rawResource.spec,
    ...rawResource.status,
    ...safeResource.metadata,
    ...safeResource.spec,
    ...safeResource.status,
    ...overrides,
  } as T
}
