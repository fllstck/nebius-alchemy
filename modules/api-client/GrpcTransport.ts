import * as Effect from 'effect/Effect'
import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import { randomUUID } from 'node:crypto'
import * as grpc from '@grpc/grpc-js'
import * as NebiusCredentials from '../Credentials'
import * as Endpoints from '../endpoints.ts'
import type { UnknownServiceError } from '../endpoints.ts'

/**
 * Manages gRPC channels to Nebius APIs.
 *
 * Channels are created lazily per endpoint and cached so that all
 * service-specific gRPC clients sharing the same endpoint reuse a
 * single underlying connection. Unhealthy channels (SHUTDOWN,
 * TRANSIENT_FAILURE) are evicted and rebuilt automatically.
 * All channels are automatically closed when the transport scope ends.
 */
export class NebiusGrpcTransport extends Context.Service<
  NebiusGrpcTransport,
  {
    /**
     * Get or create a managed gRPC channel for a raw endpoint string.
     *
     * The channel is configured with TLS and API-key-based authentication.
     * Reuses an existing channel if one already exists for this endpoint.
     */
    readonly getChannel: (endpoint: string) => Effect.Effect<grpc.Channel>

    /**
     * Force-evict a cached channel for an endpoint. The next call to
     * {@link getChannel} will create a fresh channel. Useful after
     * detecting persistent connectivity issues.
     */
    readonly evictChannel: (endpoint: string) => Effect.Effect<void>

    /**
     * Get or create a managed gRPC channel for a named Nebius service.
     *
     * Resolves the service name to an endpoint via {@link endpointFor},
     * then delegates to {@link getChannel}.
     */
    readonly channelFor: (service: string) => Effect.Effect<grpc.Channel, UnknownServiceError>
  }
>()('NebiusGrpcTransport') {}

const makeTransport = Effect.fn('NebiusGrpcTransport.make')(function* () {
  // Resolve credentials and extract the API key
  const { apiKey } = yield* yield* NebiusCredentials.NebiusCredentials

  // Channel cache keyed by endpoint string
  const channels = new Map<string, grpc.Channel>()

  const getChannel = (endpoint: string): Effect.Effect<grpc.Channel> =>
    Effect.sync(() => {
      let channel = channels.get(endpoint)
      if (channel) {
        // Check channel health before returning a cached channel.
        // Channels that have entered SHUTDOWN or TRANSIENT_FAILURE are
        // evicted so the next call creates a fresh connection.
        const state = channel.getConnectivityState(false)
        if (state === grpc.connectivityState.SHUTDOWN) {
          channels.delete(endpoint)
          channel = undefined
        } else if (state === grpc.connectivityState.TRANSIENT_FAILURE) {
          // TRANSIENT_FAILURE means the channel can't establish a connection.
          // Try waiting briefly for it to recover; if it doesn't, evict.
          const deadline = new Date(Date.now() + 5_000)
          // waitForReady is available at runtime on @grpc/grpc-js Channel
          // but the types package doesn't expose it; safe narrowing cast.
          ;(channel as unknown as { waitForReady(d: Date, cb: (err?: Error) => void): void }).waitForReady(
            deadline,
            (err?: Error) => {
              if (err) channels.delete(endpoint)
            },
          )
          // Return the (possibly-recovering) channel for this call;
          // the callback above will evict it if recovery fails.
        }
      }
      if (!channel) {
        // Build channel credentials: TLS + API key auth via metadata
        const sslCreds = grpc.credentials.createSsl()
        const authCreds = grpc.credentials.createFromMetadataGenerator((_params, callback) => {
          const metadata = new grpc.Metadata()
          metadata.add('authorization', `Bearer ${Redacted.value(apiKey)}`)
          // TEST (M3): gosdk sends X-Idempotency-Key on every request — does it
          // make creates synchronously consistent (no propagation delay)?
          metadata.add('x-idempotency-key', crypto.randomUUID())
          callback(null, metadata)
        })
        const channelCreds = grpc.credentials.combineChannelCredentials(sslCreds, authCreds)

        channel = new grpc.Channel(endpoint, channelCreds, {})
        channels.set(endpoint, channel)
      }
      return channel
    })

  const evictChannel = (endpoint: string): Effect.Effect<void> =>
    Effect.sync(() => {
      channels.delete(endpoint)
    })

  const channelFor = (service: string): Effect.Effect<grpc.Channel, UnknownServiceError> =>
    Effect.gen(function* () {
      const endpoint = yield* Endpoints.endpointFor(service)
      return yield* getChannel(endpoint)
    })

  // Ensure all channels are closed when the scope ends.
  // Each close() is wrapped in try/catch because a channel in a bad state
  // can throw during close, and we don't want a finalizer failure to crash
  // the fiber.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const channel of channels.values()) {
        try {
          channel.close()
        } catch {
          // Channel may already be in a failed state; ignore close errors.
        }
      }
    }),
  )

  return { getChannel, channelFor, evictChannel }
})

/**
 * Creates a live NebiusGrpcTransport layer scoped to the Effect runtime.
 *
 * All channels are automatically closed when the scope ends.
 *
 * Required dependencies:
 * - NebiusCredentials: provides the API key for auth
 */
export const NebiusGrpcTransportLive = Layer.effect(NebiusGrpcTransport, makeTransport())
