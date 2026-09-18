/**
 * ConfigProvider override that serves `NEBIUS_PROJECT_ID` from the project
 * chosen during `alchemy profile edit` (OAuth or sa-key bootstrap) when the env var
 * is NOT set. An explicit `NEBIUS_PROJECT_ID` in the environment always wins.
 *
 * This is the "choose projects via login flow" plumbing: the login stores the
 * chosen project in the credential store; every resource keeps reading
 * `Config.String('NEBIUS_PROJECT_ID')` unchanged, and this provider fills the
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
    // `ALCHEMY_PROFILE` is a bare `Config.String` with NO default since
    // beta.77 — reading it directly fails when unset. `currentProfileName`
    // resolves the selection properly (falling back to the default profile)
    // and only requires `ProfileStore`.
    const profileName = yield* AlchemyAuth.currentProfileName
    const store = yield* CredentialsStore

    const oauth = yield* store.read(
      profileName,
      OAUTH_STORAGE_KEY,
      NebiusAuthProvider.NebiusOAuthCredentialsSchema,
    )
    const saKey = yield* store.read(
      profileName,
      SA_STORAGE_KEY,
      NebiusAuthProvider.NebiusSaKeyCredentialsSchema,
    )
    const projectId = oauth?.projectId ?? saKey?.projectId
    // OAuth records the tenant directly; SA-key profiles record it at
    // bootstrap (derived from the project's `parentId`). Either source means
    // the user does NOT have to set NEBIUS_TENANT_ID for tenant-scoped
    // operations — only env/CI auth has to.
    const tenantId = oauth?.tenantId ?? saKey?.tenantId
    if (!projectId && !tenantId) return base

    // env/base first, stored tenant/project as the fallback for missing keys.
    return ConfigProvider.orElse(
      base,
      ConfigProvider.fromUnknown({
        ...(tenantId ? { NEBIUS_TENANT_ID: tenantId } : {}),
        ...(projectId ? { NEBIUS_PROJECT_ID: projectId } : {}),
      }),
    )
  }),
)
