// Capacity has no resources (yet) — only read-only discovery. The advisor is
// list-only, so there is no provider to register and nothing to add to
// `modules/Provider.ts`.
export * as action from './actions.ts'
export {
  ResourceAdviceAttributesSchema,
  toFriendlyAttributes as toFriendlyResourceAdvice,
  type ResourceAdviceAttributes,
} from './resource-advice.schema.ts'
