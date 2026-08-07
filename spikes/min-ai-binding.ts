/**
 * Minimal entry: imports ONLY the AI binding surface (contracts + layer +
 * schemas) — the module that must be statically workerd-safe (AD8). No
 * resource modules, no providers.
 */
export {
  ChatCompletions,
  ChatCompletionsHttp,
} from '../modules/resources/ai/v1/bindings.ts'
