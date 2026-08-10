import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as PlatformNode from '@effect/platform-node'
import { CredentialsStore } from 'alchemy/Auth/Credentials'
import * as AlchemyAuth from 'alchemy/Auth'
import { NebiusProjectConfigProviderLive } from '../../modules/auth/project-config.ts'

const makeStore = (stored: unknown) => {
  const inMemory = new Map<string, unknown>()
  if (stored !== undefined) inMemory.set('nebius-oauth', stored)
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

const resolveProject = (env: Record<string, string>, stored: unknown) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Config.string('NEBIUS_PROJECT_ID').pipe(Effect.orElseSucceed(() => '<missing>'))
    }).pipe(
      Effect.provide(NebiusProjectConfigProviderLive),
      Effect.provide(AlchemyAuth.ProfileLive),
      Effect.provide(makeStore(stored)),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.provide(PlatformNode.NodeServices.layer),
    ),
  )

const oauthStored = (projectId: string) => ({
  type: 'oauth',
  accessToken: 't',
  expiresAt: Date.now() + 60_000,
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
