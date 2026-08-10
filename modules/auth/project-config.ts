/**
 * ConfigProvider override that serves `NEBIUS_PROJECT_ID` from the project
 * chosen during `alchemy login` (OAuth or sa-key bootstrap) when the env var
 * is NOT set. An explicit `NEBIUS_PROJECT_ID` in the environment always wins.
 *
 * This is the "choose projects via login flow" plumbing: the login stores the
 * chosen project in the credential store; every resource keeps reading
 * `Config.string('NEBIUS_PROJECT_ID')` unchanged, and this provider fills the
 * gap when the env var is absent.
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { CredentialsStore } from 'alchemy/Auth/Credentials'
import * as AlchemyAuth from 'alchemy/Auth'
import * as NebiusAuthProvider from '../AuthProvider.ts'

export const OAUTH_STORAGE_KEY = 'nebius-oauth'
export const SA_STORAGE_KEY = 'nebius-sa-key'

export const NebiusProjectConfigProviderLive = Layer.effect(
  ConfigProvider.ConfigProvider,
  Effect.gen(function* () {
    const base = yield* ConfigProvider.ConfigProvider
    const profileName = yield* AlchemyAuth.ALCHEMY_PROFILE
    const store = yield* CredentialsStore

    const oauth = yield* store.read<NebiusAuthProvider.NebiusOAuthCredentials>(profileName, OAUTH_STORAGE_KEY)
    const saKey = yield* store.read<NebiusAuthProvider.NebiusSaKeyCredentials>(profileName, SA_STORAGE_KEY)
    const projectId = oauth?.projectId ?? saKey?.projectId
    if (!projectId) return base

    // env/base first, stored project as the fallback for the missing key.
    return ConfigProvider.orElse(base, ConfigProvider.fromUnknown({ NEBIUS_PROJECT_ID: projectId }))
  }),
)
