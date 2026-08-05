/**
 * Structural fake for `@grpc/grpc-js` channels — for unit tests only.
 *
 * The generated gRPC `Client` constructor accepts a `channelOverride` option
 * and simply stores the object: no channel methods are invoked while a service
 * layer is being built (see `makeGrpcService` in
 * modules/api-client/grpc-utils.ts — it constructs `new ClientClass(...)` with
 * `{ channelOverride }` and wraps the client methods). Structural tests only
 * assert that service methods exist, so a real `grpc.Channel` — which allocates
 * sockets/timers and would need `grpc.credentials.createInsecure()` — is never
 * required. See T5 in TASKS.md.
 *
 * The stubbed methods throw a descriptive error if anything actually calls
 * them: a unit test must fail loudly (not silently misbehave) if a future
 * refactor starts exercising real channel behavior.
 */
import * as grpc from '@grpc/grpc-js'

const notAvailable = (method: string): never => {
  throw new Error(
    `fakeChannel.${method}() called — real gRPC channel behavior is not available ` +
      'in unit tests. The service layer should never invoke channel methods while ' +
      'building with a channelOverride.',
  )
}

/**
 * A minimal structural fake satisfying the `grpc.Channel` interface without
 * constructing a real channel.
 *
 * Returns a fresh object per call; the mock transport layer keeps whatever
 * instance it receives, so nothing depends on identity.
 */
export const fakeChannel = (): grpc.Channel =>
  ({
    getConnectivityState: () => notAvailable('getConnectivityState'),
    watchConnectivityState: () => notAvailable('watchConnectivityState'),
    createCall: () => notAvailable('createCall'),
    getTarget: () => notAvailable('getTarget'),
    getChannelzRef: () => notAvailable('getChannelzRef'),
    addTraceEvent: () => notAvailable('addTraceEvent'),
    close: () => notAvailable('close'),
  }) as unknown as grpc.Channel
