import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as AlchemyAuth from 'alchemy/Auth'
import * as Layer from 'effect/Layer'
import * as NebiusAuthProvider from './AuthProvider.ts'

export class NebiusCredentials extends Context.Service<
  NebiusCredentials,
  Effect.Effect<{ apiKey: Redacted.Redacted<string> }>
>()('NebiusCredentials') {}

/**
 * Resolve Nebius credentials through alchemy's provider-resolution pipeline:
 * environment variables win (the CI path — profiles do not exist there), then
 * the selected profile's stored config, decoded against the provider's
 * `configSchema`. Replaces the removed
 * `AlchemyProfile.loadOrConfigure(...) + auth.read(...)` dance, and with it the
 * hand-rolled `CI` flag: alchemy now decides the environment-vs-profile
 * precedence itself and passes `updateConfig` so a provider can persist
 * refreshed material.
 */
export const fromAuthProvider = Layer.effect(
  NebiusCredentials,
  Effect.gen(function* () {
    const { resolve } = yield* AlchemyAuth.resolveProviderConfig<
      NebiusAuthProvider.NebiusAuthConfig,
      NebiusAuthProvider.NebiusResolvedCredentials
    >(NebiusAuthProvider.NEBIUS_AUTH_PROVIDER_NAME)

    return yield* resolve.pipe(
      Effect.map((creds) => ({ apiKey: creds.apiKey })),
      Effect.orDie,
      Effect.cached,
    )
  }),
)
