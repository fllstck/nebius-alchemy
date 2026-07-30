import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as AlchemyAuth from 'alchemy/Auth'
import * as Config from 'effect/Config'
import * as Layer from 'effect/Layer'
import * as NebiusAuthProvider from './AuthProvider.ts'

export class NebiusCredentials extends Context.Service<
  NebiusCredentials,
  Effect.Effect<{ apiKey: Redacted.Redacted<string> }>
>()('NebiusCredentials') {}

export const fromAuthProvider = Layer.effect(
  NebiusCredentials,
  Effect.gen(function* () {
    const profile = yield* AlchemyAuth.AlchemyProfile
    const auth = yield* AlchemyAuth.getAuthProvider<
      NebiusAuthProvider.NebiusAuthConfig,
      NebiusAuthProvider.NebiusResolvedCredentials
    >(NebiusAuthProvider.NEBIUS_AUTH_PROVIDER_NAME)
    const profileName = yield* AlchemyAuth.ALCHEMY_PROFILE
    const ci = yield* Config.boolean('CI').pipe(Config.withDefault(false))

    return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
      Effect.flatMap((config) => auth.read(profileName, config)),
      Effect.map((creds) => ({ apiKey: creds.apiKey })),
      Effect.orDie,
      Effect.cached,
    )
  }),
)
