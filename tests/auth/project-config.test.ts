import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as PlatformNode from '@effect/platform-node'
import { CredentialsStore } from 'alchemy/Auth/Credentials'
import * as AlchemyAuth from 'alchemy/Auth'
import { NebiusProjectConfigProviderLive } from '../../modules/auth/project-config.ts'

const makeStore = (stored: unknown, provider = 'nebius-oauth') => {
  const inMemory = new Map<string, unknown>()
  if (stored !== undefined) inMemory.set(provider, stored)
  return Layer.succeed(CredentialsStore, {
    read: <T>(_profile: string, provider: string) =>
      Effect.succeed(inMemory.get(provider) as T | undefined),
    write: <T>(_profile: string, provider: string, value: T) =>
      Effect.sync(() => {
        inMemory.set(provider, value)
      }),
    delete: (_profile: string, provider: string) =>
      Effect.sync(() => {
        inMemory.delete(provider)
      }),
    deleteProfile: () => Effect.void,
  })
}

/** Resolve one config key through the provider, or `'<missing>'`. */
const resolveConfigValue = (
  key: string,
  env: Record<string, string>,
  stored: unknown,
  provider = 'nebius-oauth',
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Config.string(key).pipe(Effect.orElseSucceed(() => '<missing>'))
    }).pipe(
      Effect.provide(NebiusProjectConfigProviderLive),
      Effect.provide(AlchemyAuth.ProfileStoreLive),
      Effect.provide(makeStore(stored, provider)),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.provide(PlatformNode.NodeServices.layer),
    ),
  )

const resolveProject = (env: Record<string, string>, stored: unknown) =>
  resolveConfigValue('NEBIUS_PROJECT_ID', env, stored)

const oauthStored = (projectId: string) => ({
  type: 'oauth',
  accessToken: 't',
  expiresAt: Date.now() + 60_000,
  tenantId: 'tenant-from-login',
  projectId,
})

describe('NebiusProjectConfigProviderLive', () => {
  test('serves the login-chosen project when NEBIUS_PROJECT_ID is unset', async () => {
    expect(await resolveProject({}, oauthStored('project-from-login'))).toBe('project-from-login')
  })

  test('an explicit env NEBIUS_PROJECT_ID always wins', async () => {
    expect(await resolveProject({ NEBIUS_PROJECT_ID: 'project-from-env' }, oauthStored('project-from-login'))).toBe(
      'project-from-env',
    )
  })

  test('leaves the key missing when nothing is stored', async () => {
    expect(await resolveProject({}, undefined)).toBe('<missing>')
  })
})

/**
 * `NEBIUS_TENANT_ID` is read by tenant-scoped operations (project fan-out for
 * `list`, tenant-parented resources, the discovery actions) — and `alchemy
 * unsafe nuke` is the only place alchemy calls a provider's `list`.
 *
 * It must therefore be supplied from EITHER auth method's stored profile, so
 * those operations work without the user exporting it.
 */
describe('NEBIUS_TENANT_ID resolution', () => {
  const SA_KEY_PROVIDER = 'nebius-sa-key'

  const saKeyStored = (overrides: { tenantId?: string } = {}) => ({
    type: 'saKey',
    serviceAccountId: 'serviceaccount-bootstrap',
    keyId: 'publickey-bootstrap',
    privateKey: '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----',
    projectId: 'project-from-bootstrap',
    ...overrides,
  })

  const resolveTenant = (env: Record<string, string>, stored: unknown, provider?: string) =>
    resolveConfigValue('NEBIUS_TENANT_ID', env, stored, provider)

  test('an OAuth profile supplies the tenant', async () => {
    expect(await resolveTenant({}, oauthStored('p'))).toBe('tenant-from-login')
  })

  test('an sa-key profile supplies the tenant recorded at bootstrap', async () => {
    expect(await resolveTenant({}, saKeyStored({ tenantId: 'tenant-from-bootstrap' }), SA_KEY_PROVIDER)).toBe(
      'tenant-from-bootstrap',
    )
  })

  test('a legacy sa-key profile (no recorded tenant) falls back to the env var', async () => {
    // Keys bootstrapped before the tenant was recorded must keep working via
    // the env var — this is the historical behaviour, not a regression.
    expect(await resolveTenant({ NEBIUS_TENANT_ID: 'tenant-from-env' }, saKeyStored(), SA_KEY_PROVIDER)).toBe(
      'tenant-from-env',
    )
  })

  test('a legacy sa-key profile with no env var stays missing', async () => {
    expect(await resolveTenant({}, saKeyStored(), SA_KEY_PROVIDER)).toBe('<missing>')
  })

  test('an explicit env NEBIUS_TENANT_ID wins over the profile', async () => {
    expect(await resolveTenant({ NEBIUS_TENANT_ID: 'tenant-from-env' }, oauthStored('p'))).toBe('tenant-from-env')
  })
})
