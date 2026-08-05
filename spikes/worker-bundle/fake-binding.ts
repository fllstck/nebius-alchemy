/**
 * M0 spike — simulates the D8 design: `bindings.ts` with the deploy-time
 * provisioning module loaded via a guarded dynamic import.
 */
import * as Effect from 'effect/Effect'

export const provision = Effect.fn('provision')(function* () {
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const { makeIdentity } = yield* Effect.promise(() => import('./fake-identity.ts'))
    return makeIdentity()
  }
  return 'runtime-noop'
})
