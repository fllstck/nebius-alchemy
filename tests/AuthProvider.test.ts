import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Redacted from 'effect/Redacted'
import * as PlatformNode from '@effect/platform-node'
import { AuthProviders, getAuthProvider, AuthError, NeedsReauth } from 'alchemy/Auth/AuthProvider'
import { layerNonInteractive } from 'alchemy/Interaction'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'

import {
  NebiusAuth,
  NebiusSaKeyCredentialsSchema,
  type NebiusAuthConfig,
  NEBIUS_AUTH_PROVIDER_NAME,
  type NebiusResolvedCredentials,
} from '../modules/AuthProvider.ts'
import * as SaToken from '../modules/auth/sa-token.ts'
import * as SaBootstrap from '../modules/auth/sa-bootstrap.ts'
import { writeSecureCredentials } from '../modules/auth/secure-credentials.ts'

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

/**
 * Fake SaTokenMinter — the sa-key resolution flow is tested without a real
 * gRPC server; the JWT/exchange wire path is covered by `sa-token.test.ts`.
 */
const fakeSaTokenMinter = Layer.succeed(SaToken.SaTokenMinter, {
  mint: () => Effect.succeed('minted-test-token'),
})

/** Fake SaBootstrap — the interactive bootstrap flow never touches IAM here. */
const saBootstrapImpl = {
  bootstrap: (_token: Redacted.Redacted<string>) =>
    Effect.succeed({
      serviceAccountId: 'serviceaccount-bootstrapped',
      keyId: 'publickey-bootstrapped',
      privateKey: '-----BEGIN PRIVATE KEY-----\nBOOTSTRAPPED\n-----END PRIVATE KEY-----',
    }),
  getProjectName: () => Effect.succeed('Test Project'),
  deactivateKey: (_token: Redacted.Redacted<string>, _keyId: string) => Effect.succeed(undefined),
}

const fakeSaBootstrap = Layer.succeed(SaBootstrap.SaBootstrap, saBootstrapImpl)

/**
 * Base layer providing platform dependencies (FileSystem, ChildProcessSpawner,
 * ConfigProvider). Everything else builds on top.
 */
const baseServices = Layer.mergeAll(
  PlatformNode.NodeServices.layer,
  ConfigProvider.layer(ConfigProvider.fromUnknown({})),
)

/**
 * Layer providing the credentials store (backed by FileSystem).
 */
const credentialsLayer = AlchemyCredentials.CredentialsStoreLive.pipe(Layer.provide(baseServices))

/**
 * Complete test layer: all auth provider machinery wired up.
 * Uses the same `mergeAll + provideMerge` pattern as Alchemy's own
 * `Auth/Profile.test.ts`.
 */
const authTestLayer = Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
  Layer.provide(credentialsLayer),
  Layer.provideMerge(
    Layer.mergeAll(Layer.succeed(AuthProviders, {}), baseServices, fakeSaTokenMinter, fakeSaBootstrap),
  ),
)

/** Build with custom env vars substituted into ConfigProvider. */
const authTestLayerWithEnv = (env: Record<string, string>) =>
  Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
    Layer.provide(credentialsLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        PlatformNode.NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
        fakeSaTokenMinter,
        fakeSaBootstrap,
      ),
    ),
  )

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolveCredentials = (profileName: string, config: NebiusAuthConfig) =>
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<NebiusAuthConfig, NebiusResolvedCredentials>(NEBIUS_AUTH_PROVIDER_NAME)
    return yield* auth.read(profileName, config)
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NebiusAuth', () => {
  describe('layer construction', () => {
    test('can be built without errors', async () => {
      // Layer.build validates that all dependencies are satisfied.
      await Effect.runPromise(Effect.scoped(Layer.build(authTestLayer).pipe(Effect.asVoid)))
    })

    test('provides AuthProviders context', async () => {
      const providers = await Effect.runPromise(AuthProviders.pipe(Effect.provide(authTestLayer)))

      expect(providers).toBeDefined()
      expect(typeof providers).toBe('object')
    })
  })

  describe('resolveCredentials — env method', () => {
    test('fails with a clear message when NEBIUS_API_KEY is not set', async () => {
      const error = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'env' }).pipe(Effect.flip, Effect.provide(authTestLayer)),
      )

      expect(error).toBeInstanceOf(AuthError)
      if (error instanceof AuthError) {
        expect(error.message).toContain('NEBIUS_API_KEY')
      }
    })

    test('resolves credentials when NEBIUS_API_KEY is set', async () => {
      const creds = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'env' }).pipe(
          Effect.provide(authTestLayerWithEnv({ NEBIUS_API_KEY: 'test-api-key-12345' })),
        ),
      )

      expect(creds.type).toBe('apiKey')
      expect(Redacted.value(creds.apiKey)).toBe('test-api-key-12345')
      expect(creds.source.type).toBe('env')
    })

    test('credentials are Redacted (never leaked via toString)', async () => {
      const creds = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'env' }).pipe(
          Effect.provide(authTestLayerWithEnv({ NEBIUS_API_KEY: 'secret-value' })),
        ),
      )

      // Redacted overrides toString to return a masked value.
      // Verify the secret is NOT present in the string representation.
      expect(JSON.stringify(creds.apiKey)).not.toContain('secret-value')
    })
  })

  describe('resolveCredentials — stored method', () => {
    test('fails when no stored credentials exist', async () => {
      const error = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'stored' }).pipe(Effect.flip, Effect.provide(authTestLayer)),
      )

      expect(error).toBeInstanceOf(NeedsReauth)
      if (error instanceof NeedsReauth) {
        expect(error.message).toContain('stored')
      }
    })
  })

  describe('resolveCredentials — oauth method', () => {
    const oauthLayerWithStore = (stored: unknown) => {
      const inMemory = new Map<string, unknown>()
      const fakeStore = Layer.succeed(AlchemyCredentials.CredentialsStore, {
        read: <T>(profile: string, provider: string) =>
          Effect.succeed(inMemory.get(`${profile}:${provider}`) as T | undefined),
        write: <T>(profile: string, provider: string, value: T) =>
          Effect.sync(() => {
            inMemory.set(`${profile}:${provider}`, value)
          }),
        delete: (profile: string, provider: string) =>
          Effect.sync(() => {
            inMemory.delete(`${profile}:${provider}`)
          }),
        deleteProfile: (profile: string) =>
          Effect.sync(() => {
            for (const key of inMemory.keys()) if (key.startsWith(`${profile}:`)) inMemory.delete(key)
          }),
      })
      inMemory.set('test-profile:nebius-oauth', stored)
      return Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
        Layer.provide(fakeStore),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(AuthProviders, {}),
            PlatformNode.NodeServices.layer,
            ConfigProvider.layer(ConfigProvider.fromUnknown({})),
            fakeSaTokenMinter,
            fakeSaBootstrap,
          ),
        ),
      )
    }

    test('resolves a valid stored token', async () => {
      const creds = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'oauth' }).pipe(
          Effect.provide(
            oauthLayerWithStore({
              type: 'oauth',
              accessToken: 'oauth-token-123',
              expiresAt: Date.now() + 60_000,
              tenantId: 'tenant-oauth-1',
              projectId: 'project-oauth-1',
            }),
          ),
        ),
      )
      expect(Redacted.value(creds.apiKey)).toBe('oauth-token-123')
      expect(creds.source.type).toBe('oauth')
      expect(creds.source.details).toBe('project-oauth-1')
    })

    test('fails with guidance when the token expired', async () => {
      const error = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'oauth' }).pipe(
          Effect.flip,
          Effect.provide(
            oauthLayerWithStore({
              type: 'oauth',
              accessToken: 'stale',
              expiresAt: Date.now() - 1,
              tenantId: 'tenant-oauth-1',
              projectId: 'project-oauth-1',
            }),
          ),
        ),
      )
      expect(error).toBeInstanceOf(NeedsReauth)
      if (error instanceof NeedsReauth) expect(error.message).toContain('expired')
    })

    test('fails with guidance when nothing is stored', async () => {
      const error = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'oauth' }).pipe(
          Effect.flip,
          Effect.provide(oauthLayerWithStore(undefined)),
        ),
      )
      expect(error).toBeInstanceOf(NeedsReauth)
      if (error instanceof NeedsReauth) expect(error.message).toContain('alchemy login')
    })
  })

  describe('resolveCredentials — sa-key method', () => {
    test('fails with a clear message when SA env vars are missing', async () => {
      const error = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'sa-key' }).pipe(Effect.flip, Effect.provide(authTestLayer)),
      )

      expect(error).toBeInstanceOf(AuthError)
      if (error instanceof AuthError) {
        expect(error.message).toContain('NEBIUS_SA_ID')
        expect(error.message).toContain('NEBIUS_SA_KEY_ID')
        expect(error.message).toContain('NEBIUS_SA_PRIVATE_KEY')
        expect(error.message).toContain('alchemy login')
      }
    })

    test('resolves credentials from SA env vars via the minter', async () => {
      const creds = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'sa-key' }).pipe(
          Effect.provide(
            authTestLayerWithEnv({
              NEBIUS_SA_ID: 'serviceaccount-test-1',
              NEBIUS_SA_KEY_ID: 'akey-test-1',
              NEBIUS_SA_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
            }),
          ),
        ),
      )

      expect(creds.type).toBe('apiKey')
      expect(Redacted.value(creds.apiKey)).toBe('minted-test-token')
      expect(creds.source.type).toBe('sa-key')
      expect(creds.source.details).toBe('serviceaccount-test-1')
    })

    test('reads the private key from NEBIUS_SA_PRIVATE_KEY_FILE when set', async () => {
      const keyPath = '/tmp/nebius-sa-test-key.pem'
      await Bun.write(keyPath, '-----BEGIN PRIVATE KEY-----\nFILEKEY\n-----END PRIVATE KEY-----')
      try {
        const creds = await Effect.runPromise(
          resolveCredentials('test-profile', { method: 'sa-key' }).pipe(
            Effect.provide(
              authTestLayerWithEnv({
                NEBIUS_SA_ID: 'serviceaccount-test-2',
                NEBIUS_SA_KEY_ID: 'akey-test-2',
                NEBIUS_SA_PRIVATE_KEY_FILE: keyPath,
              }),
            ),
          ),
        )

        expect(creds.source.details).toBe('serviceaccount-test-2')
      } finally {
        await Bun.$`rm -f ${keyPath}`.quiet()
      }
    })

    test('resolves from the credential store when env vars are absent', async () => {
      const inMemory = new Map<string, unknown>()
      const fakeStore = Layer.succeed(AlchemyCredentials.CredentialsStore, {
        read: <T>(profile: string, provider: string) =>
          Effect.succeed(inMemory.get(`${profile}:${provider}`) as T | undefined),
        write: <T>(profile: string, provider: string, value: T) =>
          Effect.sync(() => {
            inMemory.set(`${profile}:${provider}`, value)
          }),
        delete: (profile: string, provider: string) =>
          Effect.sync(() => {
            inMemory.delete(`${profile}:${provider}`)
          }),
        deleteProfile: (profile: string) =>
          Effect.sync(() => {
            for (const key of inMemory.keys()) if (key.startsWith(`${profile}:`)) inMemory.delete(key)
          }),
      })
      inMemory.set('test-profile:nebius-sa-key', {
        type: 'saKey',
        serviceAccountId: 'serviceaccount-stored',
        keyId: 'publickey-stored',
        privateKey: 'STORED-PEM',
        projectId: 'project-stored',
      })

      const layer = Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
        Layer.provide(fakeStore),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(AuthProviders, {}),
            PlatformNode.NodeServices.layer,
            ConfigProvider.layer(ConfigProvider.fromUnknown({})),
            fakeSaTokenMinter,
            fakeSaBootstrap,
          ),
        ),
      )

      const creds = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'sa-key' }).pipe(Effect.provide(layer)),
      )
      expect(Redacted.value(creds.apiKey)).toBe('minted-test-token')
      expect(creds.source.details).toBe('serviceaccount-stored')
    })

    test('env vars override stored material', async () => {
      const inMemory = new Map<string, unknown>()
      const fakeStore = Layer.succeed(AlchemyCredentials.CredentialsStore, {
        read: <T>(profile: string, provider: string) =>
          Effect.succeed(inMemory.get(`${profile}:${provider}`) as T | undefined),
        write: <T>(profile: string, provider: string, value: T) =>
          Effect.sync(() => {
            inMemory.set(`${profile}:${provider}`, value)
          }),
        delete: (profile: string, provider: string) =>
          Effect.sync(() => {
            inMemory.delete(`${profile}:${provider}`)
          }),
        deleteProfile: (profile: string) =>
          Effect.sync(() => {
            for (const key of inMemory.keys()) if (key.startsWith(`${profile}:`)) inMemory.delete(key)
          }),
      })
      inMemory.set('test-profile:nebius-sa-key', {
        type: 'saKey',
        serviceAccountId: 'serviceaccount-stored',
        keyId: 'publickey-stored',
        privateKey: 'STORED-PEM',
        projectId: 'project-stored',
      })

      const layer = Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
        Layer.provide(fakeStore),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(AuthProviders, {}),
            PlatformNode.NodeServices.layer,
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                NEBIUS_SA_ID: 'serviceaccount-env',
                NEBIUS_SA_KEY_ID: 'publickey-env',
                NEBIUS_SA_PRIVATE_KEY: 'ENV-PEM',
              }),
            ),
            fakeSaTokenMinter,
            fakeSaBootstrap,
          ),
        ),
      )

      const creds = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'sa-key' }).pipe(Effect.provide(layer)),
      )
      expect(creds.source.details).toBe('serviceaccount-env')
    })
  })

  describe('provider registration', () => {
    test('provider name constant matches expected value', () => {
      expect(NEBIUS_AUTH_PROVIDER_NAME).toBe('Nebius')
    })

    test('can retrieve the provider via getAuthProvider', async () => {
      const auth = await Effect.runPromise(
        getAuthProvider<NebiusAuthConfig, NebiusResolvedCredentials>(NEBIUS_AUTH_PROVIDER_NAME).pipe(
          Effect.provide(authTestLayer),
        ),
      )

      expect(auth).toBeDefined()
      expect(typeof auth.read).toBe('function')
      expect(typeof auth.configure).toBe('function')
      expect(typeof auth.login).toBe('function')
      expect(typeof auth.logout).toBe('function')
      expect(typeof auth.details).toBe('function')
    })
  })

  describe('resolveCredentials — removed nebius-cli migration guard', () => {
    test('stored nebius-cli config fails with guidance, not a crash', async () => {
      // Simulates a pre-OAuth profile: the stored method is `nebius-cli`,
      // which no longer exists in the config union.
      const error = await Effect.runPromise(
        resolveCredentials('test-profile', { method: 'nebius-cli' as never }).pipe(
          Effect.flip,
          Effect.provide(authTestLayer),
        ),
      )
      expect(error).toBeInstanceOf(AuthError)
      if (error instanceof AuthError) {
        expect(error.message).toContain('no longer supported')
        expect(error.message).toContain('alchemy login')
      }
    })
  })

  describe('logout — sa-key deactivates the authorized key server-side', () => {
    const SA_KEY_PROVIDER = 'nebius-sa-key'

    /** Layer with a capturing deactivateKey. */
    const logoutLayer = (
      calls: Array<{ keyId: string }>,
      deactivate: () => Effect.Effect<void, SaBootstrap.SaBootstrapError>,
    ) =>
      Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
        Layer.provide(credentialsLayer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(AuthProviders, {}),
            baseServices,
            // `logout` reports through `Interaction` now, so the layer must
            // provide it. Non-interactive is correct here — logout only ever
            // *outputs*, it never prompts.
            layerNonInteractive(),
            fakeSaTokenMinter,
            Layer.succeed(SaBootstrap.SaBootstrap, {
              ...saBootstrapImpl,
              deactivateKey: (_token: Redacted.Redacted<string>, keyId: string) =>
                Effect.sync(() => {
                  calls.push({ keyId })
                  return undefined
                }).pipe(Effect.andThen(deactivate)),
            }),
          ),
        ),
      )

    /** Logout effect for the sa-key method (provided at the call site). */
    const logoutSaKey = (profile: string) =>
      Effect.gen(function* () {
        const auth = yield* getAuthProvider<NebiusAuthConfig, NebiusResolvedCredentials>(NEBIUS_AUTH_PROVIDER_NAME)
        return yield* auth.logout(profile, { method: 'sa-key' })
      })

    test('deactivates the key server-side, then removes local credentials', async () => {
      const profile = `logout-test-${randomUUID()}`
      const calls: Array<{ keyId: string }> = []
      const layer = logoutLayer(calls, () => Effect.succeed(undefined))
      await Effect.gen(function* () {
        const store = yield* AlchemyCredentials.CredentialsStore
        try {
          yield* writeSecureCredentials(store, profile, SA_KEY_PROVIDER, NebiusSaKeyCredentialsSchema, {
            type: 'saKey',
            serviceAccountId: 'serviceaccount-logout',
            keyId: 'publickey-logout',
            privateKey: '-----BEGIN PRIVATE KEY-----\nLOGOUT\n-----END PRIVATE KEY-----',
            projectId: 'project-logout',
          })
          yield* logoutSaKey(profile).pipe(Effect.provide(layer))

          // Server-side deactivation was requested with the stored key ID.
          expect(calls).toEqual([{ keyId: 'publickey-logout' }])
          // Local material is gone.
          const remaining = yield* store.read(profile, SA_KEY_PROVIDER, NebiusSaKeyCredentialsSchema)
          expect(remaining).toBeUndefined()
        } finally {
          yield* store.deleteProfile(profile)
        }
      }).pipe(Effect.provide(Layer.mergeAll(baseServices, credentialsLayer)), Effect.runPromise)
    })

    test('deactivation failure falls back to local-only cleanup (no throw)', async () => {
      const profile = `logout-test-${randomUUID()}`
      const calls: Array<{ keyId: string }> = []
      const layer = logoutLayer(calls, () =>
        Effect.fail(new SaBootstrap.SaBootstrapError({ message: 'SA lacks IAM permission to deactivate' })),
      )
      await Effect.gen(function* () {
        const store = yield* AlchemyCredentials.CredentialsStore
        try {
          yield* writeSecureCredentials(store, profile, SA_KEY_PROVIDER, NebiusSaKeyCredentialsSchema, {
            type: 'saKey',
            serviceAccountId: 'serviceaccount-logout',
            keyId: 'publickey-logout',
            privateKey: '-----BEGIN PRIVATE KEY-----\nLOGOUT\n-----END PRIVATE KEY-----',
            projectId: 'project-logout',
          })
          // Logout must NOT fail even though deactivation errored.
          yield* logoutSaKey(profile).pipe(Effect.provide(layer))
          expect(calls).toEqual([{ keyId: 'publickey-logout' }])
          const remaining = yield* store.read(profile, SA_KEY_PROVIDER, NebiusSaKeyCredentialsSchema)
          expect(remaining).toBeUndefined()
        } finally {
          yield* store.deleteProfile(profile)
        }
      }).pipe(Effect.provide(Layer.mergeAll(baseServices, credentialsLayer)), Effect.runPromise)
    })

    test('with no stored key, still succeeds (local cleanup only)', async () => {
      const profile = `logout-test-${randomUUID()}`
      const calls: Array<{ keyId: string }> = []
      const layer = logoutLayer(calls, () => Effect.succeed(undefined))
      await Effect.runPromise(logoutSaKey(profile).pipe(Effect.provide(layer)))
      expect(calls).toEqual([])
    })
  })

  describe('NebiusAuthConfig discriminated union', () => {
    test('accepts env config', () => {
      const config: NebiusAuthConfig = { method: 'env' }
      expect(config.method).toBe('env')
    })

    test('accepts stored config', () => {
      const config: NebiusAuthConfig = { method: 'stored' }
      expect(config.method).toBe('stored')
    })

    test('accepts sa-key config', () => {
      const config: NebiusAuthConfig = {
        method: 'sa-key',
      }
      expect(config.method).toBe('sa-key')
    })

    test('accepts oauth config', () => {
      const config: NebiusAuthConfig = {
        method: 'oauth',
      }
      expect(config.method).toBe('oauth')
    })
  })
})
