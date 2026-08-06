import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Redacted from 'effect/Redacted'
import * as PlatformNode from '@effect/platform-node'
import { AuthProviders, getAuthProvider, AuthError } from 'alchemy/Auth/AuthProvider'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'

import {
  NebiusAuth,
  type NebiusAuthConfig,
  NEBIUS_AUTH_PROVIDER_NAME,
  type NebiusResolvedCredentials,
} from '../modules/AuthProvider.ts'

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

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
const authTestLayer = Layer.mergeAll(AlchemyProfile.ProfileLive, NebiusAuth).pipe(
  Layer.provide(credentialsLayer),
  Layer.provideMerge(Layer.mergeAll(Layer.succeed(AuthProviders, {}), baseServices)),
)

/** Build with custom env vars substituted into ConfigProvider. */
const authTestLayerWithEnv = (env: Record<string, string>) =>
  Layer.mergeAll(AlchemyProfile.ProfileLive, NebiusAuth).pipe(
    Layer.provide(credentialsLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        PlatformNode.NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
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

      expect(error).toBeInstanceOf(AuthError)
      if (error instanceof AuthError) {
        expect(error.message).toContain('stored')
      }
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
      expect(typeof auth.prettyPrint).toBe('function')
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

    test('accepts nebius-cli config', () => {
      const config: NebiusAuthConfig = {
        method: 'nebius-cli',
      }
      expect(config.method).toBe('nebius-cli')
    })
  })
})
