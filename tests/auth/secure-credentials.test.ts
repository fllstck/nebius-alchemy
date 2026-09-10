import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, statSync } from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as Schema from 'effect/Schema'
import { writeSecureCredentials } from '../../modules/auth/secure-credentials.ts'

//
// Since alchemy v2 beta.77 the credential store round-trips every document
// through a `Schema.Codec`, so writes declare the shape they are persisting.
//
const SaKeyCredentialsSchema = Schema.Struct({
  type: Schema.Literal('saKey'),
  serviceAccountId: Schema.String,
  keyId: Schema.String,
  privateKey: Schema.String,
  projectId: Schema.String,
})

const OAuthCredentialsSchema = Schema.Struct({
  type: Schema.Literal('oauth'),
  accessToken: Schema.String,
})

// ---------------------------------------------------------------------------
// Layer construction (same pattern as AuthProvider.test.ts)
// ---------------------------------------------------------------------------

const baseServices = Layer.mergeAll(
  PlatformNode.NodeServices.layer,
  ConfigProvider.layer(ConfigProvider.fromUnknown({})),
)

const credentialsLayer = AlchemyCredentials.CredentialsStoreLive.pipe(Layer.provide(baseServices))

/**
 * Write via the helper with a unique profile (the store writes to the real
 * `~/.alchemy/credentials/{profile}`), assert the on-disk mode, then clean up.
 */
const writeAndStat = <A, E>(provider: string, schema: Schema.Codec<A, E>, credentials: A) => {
  const profile = `secure-credentials-${randomUUID()}`
  return Effect.gen(function* () {
    const store = yield* AlchemyCredentials.CredentialsStore
    try {
      yield* writeSecureCredentials(store, profile, provider, schema, credentials)
      const path = AlchemyCredentials.credentialsFilePath(profile, provider)
      return { profile, path, mode: statSync(path).mode & 0o777, contents: readFileSync(path, 'utf8') }
    } finally {
      yield* store.deleteProfile(profile)
    }
  }).pipe(Effect.provide(Layer.mergeAll(baseServices, credentialsLayer)), Effect.runPromise)
}

describe('writeSecureCredentials', () => {
  test('writes the credential file with mode 0600', async () => {
    const credentials = {
      type: 'saKey',
      serviceAccountId: 'serviceaccount-test',
      keyId: 'publickey-test',
      privateKey: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----',
      projectId: 'project-test',
    }
    const { mode, contents } = await writeAndStat('nebius-sa-key', SaKeyCredentialsSchema, credentials)
    expect(mode).toBe(0o600)
    expect(JSON.parse(contents)).toEqual(credentials)
  })

  test('re-secures a pre-existing world-readable file to 0600', async () => {
    const profile = `secure-credentials-${randomUUID()}`
    const provider = 'nebius-oauth'
    await Effect.gen(function* () {
      const store = yield* AlchemyCredentials.CredentialsStore
      try {
        // Simulate the vulnerable state: a 0644 file left by a raw store write.
        yield* writeSecureCredentials(store, profile, provider, OAuthCredentialsSchema, {
          type: 'oauth',
          accessToken: 'tok',
        })
        const path = AlchemyCredentials.credentialsFilePath(profile, provider)
        chmodSync(path, 0o644)
        expect(statSync(path).mode & 0o777).toBe(0o644)

        // Overwriting through the helper restores 0600.
        yield* writeSecureCredentials(store, profile, provider, OAuthCredentialsSchema, {
          type: 'oauth',
          accessToken: 'tok2',
        })
        expect(statSync(path).mode & 0o777).toBe(0o600)
      } finally {
        yield* store.deleteProfile(profile)
      }
    }).pipe(Effect.provide(Layer.mergeAll(baseServices, credentialsLayer)), Effect.runPromise)
  })
})
