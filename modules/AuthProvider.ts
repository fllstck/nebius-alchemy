import { AuthProviderLayer } from 'alchemy/Auth/AuthProvider'
import { CredentialsStore } from 'alchemy/Auth/Credentials'
import { Redacted } from 'effect'
import * as Effect from 'effect/Effect'
import * as Duration from 'effect/Duration'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { AuthError, type ConfigureContext } from 'alchemy/Auth/AuthProvider'
import { retryOnce } from 'alchemy/Auth/Env'
import * as Clank from 'alchemy/Util/Clank'
import * as Match from 'effect/Match'
import { getEnvRedacted } from 'alchemy/Auth/Env'
import { displayRedacted } from 'alchemy/Auth/Credentials'
import * as Console from 'effect/Console'
import { readFile } from 'node:fs/promises'

import * as SaToken from './auth/sa-token.ts'

export const NEBIUS_AUTH_PROVIDER_NAME = 'Nebius'
const STORAGE_KEY = 'nebius-stored'

// Service-account key env vars (the non-interactive RFC 8693 exchange path).
const SA_ID_ENV = 'NEBIUS_SA_ID'
const SA_KEY_ID_ENV = 'NEBIUS_SA_KEY_ID'
const SA_PRIVATE_KEY_ENV = 'NEBIUS_SA_PRIVATE_KEY'
const SA_PRIVATE_KEY_FILE_ENV = 'NEBIUS_SA_PRIVATE_KEY_FILE'

export type NebiusAuthConfig =
  | { method: 'env' }
  | { method: 'stored' }
  | { method: 'nebius-cli' }
  | { method: 'sa-key' }

/**
 * Credentials persisted to the Alchemy credential store.
 *
 * **⚠️ Security note:** Alchemy's {@link CredentialsStore} writes these
 * credentials as **unencrypted JSON** to
 * `~/.alchemy/credentials/{profile}/nebius-stored.json`. The `apiKey` field
 * is redacted in logs and console output (via {@link Redacted.make}), but
 * is stored as plaintext on disk.
 *
 * For production use, prefer the `sa-key` method (non-interactive RFC 8693
 * exchange from env, short-lived 12-hour IAM tokens) or the `nebius-cli`
 * method (delegates to the CLI); the `env` method reads `NEBIUS_API_KEY`
 * without persisting to disk.
 */
export type NebiusStoredCredentials = {
  type: 'apiKey'
  apiKey: string
}

export type NebiusResolvedCredentials = {
  type: 'apiKey'
  apiKey: Redacted.Redacted<string>
  source: { type: NebiusAuthConfig['method']; details?: string }
}

// Token TTL: 11 hours (within the 12-hour expiry of Nebius IAM tokens)
const TOKEN_TTL = Duration.hours(11)

export const NebiusAuth = AuthProviderLayer<NebiusAuthConfig, NebiusResolvedCredentials>()(
  NEBIUS_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const credentialStore = yield* CredentialsStore
    const childProcessSpawner = yield* ChildProcessSpawner
    const saTokenMinter = yield* SaToken.SaTokenMinter

    const getTokenViaCli = (): Effect.Effect<string, AuthError> =>
      Effect.gen(function* () {
        const handle = yield* childProcessSpawner.spawn(
          ChildProcess.make('nebius', ['iam', 'get-access-token'], { shell: false }),
        )
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
          ],
          { concurrency: 3 },
        )
        if (exitCode !== 0)
          return yield* new AuthError({
            message: `nebius iam get-access-token exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
          })

        const token = stdout.trim()
        if (!token) return yield* new AuthError({ message: 'nebius iam get-access-token returned empty output' })

        return token
      }).pipe(
        Effect.scoped,
        Effect.mapError((e) =>
          e instanceof AuthError
            ? e
            : new AuthError({
                message:
                  'Could not invoke `nebius`. Install Nebius CLI from https://docs.nebius.com/cli/install and run `nebius profile create`.',
                cause: e,
              }),
        ),
      )

    // Cached token source with TTL-based invalidation.
    // getRawToken() is called once to obtain the effect; cachedInvalidateWithTTL
    // memoizes its result for TOKEN_TTL, re-executing on expiry or manual invalidation.
    const [cachedToken, invalidateToken] = yield* Effect.cachedInvalidateWithTTL(getTokenViaCli(), TOKEN_TTL)

    // Resolve SA-key credentials from env: NEBIUS_SA_ID + NEBIUS_SA_KEY_ID +
    // NEBIUS_SA_PRIVATE_KEY (inline PEM) or NEBIUS_SA_PRIVATE_KEY_FILE.
    const readSaKey = Effect.fn('NebiusAuth.readSaKey')(function* (): Effect.fn.Return<
      SaToken.SaKey,
      AuthError
    > {
      const serviceAccountId = yield* getEnvRedacted(SA_ID_ENV)
      const keyId = yield* getEnvRedacted(SA_KEY_ID_ENV)
      const privateKeyValue = yield* getEnvRedacted(SA_PRIVATE_KEY_ENV)
      const privateKeyFile = yield* getEnvRedacted(SA_PRIVATE_KEY_FILE_ENV)

      if (serviceAccountId == null || keyId == null || (privateKeyValue == null && privateKeyFile == null)) {
        const missing: string[] = []
        if (serviceAccountId == null) missing.push(SA_ID_ENV)
        if (keyId == null) missing.push(SA_KEY_ID_ENV)
        if (privateKeyValue == null && privateKeyFile == null) {
          missing.push(`${SA_PRIVATE_KEY_ENV} (or ${SA_PRIVATE_KEY_FILE_ENV})`)
        }
        return yield* new AuthError({
          message: `Nebius service-account key credentials not found. Set ${missing.join(', ')}.`,
        })
      }

      let privateKey: string
      if (privateKeyFile != null) {
        const filePath = Redacted.value(privateKeyFile)
        privateKey = yield* Effect.tryPromise(() => readFile(filePath, 'utf8')).pipe(
          Effect.mapError(
            () => new AuthError({ message: `Could not read private key file ${filePath}` }),
          ),
        )
      } else if (privateKeyValue != null) {
        privateKey = Redacted.value(privateKeyValue)
      } else {
        return yield* new AuthError({
          message: `Nebius service-account key credentials not found. Set ${SA_PRIVATE_KEY_ENV} (or ${SA_PRIVATE_KEY_FILE_ENV}).`,
        })
      }

      return {
        serviceAccountId: Redacted.value(serviceAccountId),
        keyId: Redacted.value(keyId),
        privateKey,
      }
    })

    // Cached SA-key token: minted once per TTL (the 5-min JWT is signed fresh
    // on each cache miss; only the 12-hour access token is cached).
    const [cachedSaToken, invalidateSaToken] = yield* Effect.cachedInvalidateWithTTL(
      Effect.gen(function* () {
        const key = yield* readSaKey()
        const token = yield* saTokenMinter.mint(key).pipe(
          Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
        )
        return { token, serviceAccountId: key.serviceAccountId }
      }),
      TOKEN_TTL,
    )

    const loginStored = Effect.fn(function* (profileName: string) {
      const apiKey = yield* Clank.password({
        message: 'Nebius API Key',
        validate: (v) => (v.length === 0 ? 'Required' : undefined),
      }).pipe(retryOnce)

      yield* credentialStore.write<NebiusStoredCredentials>(profileName, STORAGE_KEY, {
        type: 'apiKey',
        apiKey,
      })
      yield* Clank.success('Nebius: credentials saved.')
      return { method: 'stored' as const }
    })

    const configureInteractive = (profileName: string) =>
      Clank.select({
        message: 'Nebius authentication method',
        options: [
          {
            value: 'nebius-cli' as const,
            label: 'Nebius CLI',
            hint: 'delegate to `nebius iam get-access-token` (run `nebius profile create` first)',
          },
          {
            value: 'sa-key' as const,
            label: 'Service Account Key',
            hint: `non-interactive RFC 8693 exchange — set ${SA_ID_ENV} + ${SA_KEY_ID_ENV} + private key`,
          },
          { value: 'env' as const, label: 'Environment Variable', hint: 'NEBIUS_API_KEY' },
          {
            value: 'stored' as const,
            label: 'API Key',
            hint: 'enter interactively, stored in ~/.alchemy/credentials',
          },
        ],
      }).pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when('nebius-cli', () =>
              cachedToken.pipe(
                Effect.as({ method: 'nebius-cli' as const }),
                Effect.mapError(
                  (e) =>
                    new AuthError({
                      message: `Nebius CLI not available: ${e.message}`,
                      cause: e,
                    }),
                ),
              ),
            ),
            Match.when('sa-key', () =>
              cachedSaToken.pipe(
                Effect.as({ method: 'sa-key' as const }),
                Effect.mapError(
                  (e) =>
                    new AuthError({
                      message: `Nebius service-account key not usable: ${e.message}`,
                      cause: e,
                    }),
                ),
              ),
            ),
            Match.when('env', () => Effect.succeed({ method: 'env' as const })),
            Match.when('stored', () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      )

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) {
          // Non-interactive default: prefer the static API key, fall back to
          // the service-account key exchange when SA env vars are present.
          const apiKey = yield* getEnvRedacted('NEBIUS_API_KEY')
          if (apiKey) return { method: 'env' as const }
          const saId = yield* getEnvRedacted(SA_ID_ENV)
          const keyId = yield* getEnvRedacted(SA_KEY_ID_ENV)
          const privateKey = yield* getEnvRedacted(SA_PRIVATE_KEY_ENV)
          const privateKeyFile = yield* getEnvRedacted(SA_PRIVATE_KEY_FILE_ENV)
          if (saId || keyId || privateKey || privateKeyFile) return { method: 'sa-key' as const }
          return { method: 'env' as const }
        }
        return yield* configureInteractive(profileName)
      }).pipe(Effect.mapError((e) => new AuthError({ message: 'failed to configure credentials', cause: e })))

    const resolveCredentials = (
      profileName: string,
      config: NebiusAuthConfig,
    ): Effect.Effect<NebiusResolvedCredentials, AuthError> =>
      Match.value(config).pipe(
        Match.when({ method: 'nebius-cli' }, () =>
          cachedToken.pipe(
            Effect.map((token) => ({
              type: 'apiKey' as const,
              apiKey: Redacted.make(token),
              source: { type: 'nebius-cli' as const },
            })),
          ),
        ),
        Match.when({ method: 'sa-key' }, () =>
          cachedSaToken.pipe(
            Effect.map(({ token, serviceAccountId }) => ({
              type: 'apiKey' as const,
              apiKey: Redacted.make(token),
              source: { type: 'sa-key' as const, details: serviceAccountId },
            })),
          ),
        ),
        Match.when(
          { method: 'env' },
          Effect.fn(function* () {
            const apiKey = yield* getEnvRedacted('NEBIUS_API_KEY')
            if (!apiKey) {
              return yield* new AuthError({
                message: 'Nebius env credentials not found. Set NEBIUS_API_KEY.',
              })
            }
            return {
              type: 'apiKey' as const,
              apiKey,
              source: { type: 'env' as const },
            }
          }),
        ),
        Match.when({ method: 'stored' }, () =>
          credentialStore.read<NebiusStoredCredentials>(profileName, STORAGE_KEY).pipe(
            Effect.flatMap((creds) =>
              creds == null
                ? Effect.fail(
                    new AuthError({
                      message: 'Nebius stored credentials not found. Run: alchemy login --configure',
                    }),
                  )
                : Effect.succeed({
                    type: 'apiKey' as const,
                    apiKey: Redacted.make(creds.apiKey),
                    source: { type: 'stored' as const },
                  }),
            ),
          ),
        ),
        Match.exhaustive,
      )

    const login = (profileName: string, config: NebiusAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: 'env' }, () => Effect.void),
        Match.when({ method: 'nebius-cli' }, () =>
          cachedToken.pipe(
            Effect.tap(() => Clank.success('Nebius: CLI authentication available.')),
            Effect.asVoid,
          ),
        ),
        Match.when({ method: 'sa-key' }, () =>
          cachedSaToken.pipe(
            Effect.tap(() => Clank.success('Nebius: service-account key exchange available.')),
            Effect.asVoid,
          ),
        ),
        Match.when({ method: 'stored' }, () =>
          credentialStore
            .read<NebiusStoredCredentials>(profileName, STORAGE_KEY)
            .pipe(Effect.flatMap((creds) => (creds == null ? loginStored(profileName) : Effect.void))),
        ),
        Match.exhaustive,
        Effect.mapError((e) => new AuthError({ message: 'login failed', cause: e })),
      )

    const logout = (profileName: string, config: NebiusAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: 'env' }, () => Effect.void),
        Match.when({ method: 'nebius-cli' }, () =>
          invalidateToken.pipe(Effect.andThen(Clank.success('Nebius: CLI token cache invalidated.'))),
        ),
        Match.when({ method: 'sa-key' }, () =>
          invalidateSaToken.pipe(Effect.andThen(Clank.success('Nebius: SA-key token cache invalidated.'))),
        ),
        Match.when({ method: 'stored' }, () =>
          credentialStore
            .delete(profileName, STORAGE_KEY)
            .pipe(Effect.andThen(Clank.success('Nebius: stored credentials removed'))),
        ),
        Match.exhaustive,
      )

    const prettyPrint = (profileName: string, config: NebiusAuthConfig) =>
      resolveCredentials(profileName, config).pipe(
        Effect.tap((creds) => {
          const sourceStr = creds.source.details ? `${creds.source.type} - ${creds.source.details}` : creds.source.type
          return Effect.all([
            Console.log(`  apiKey: ${displayRedacted(creds.apiKey, 7)}`),
            Console.log(`  source: ${sourceStr}`),
          ])
        }),
        Effect.catch((e) => Console.error(`  Failed to retrieve credentials: ${String(e)}`)),
      )

    return {
      configure: configureCredentials,
      login,
      logout,
      prettyPrint,
      read: resolveCredentials,
    }
  }),
)
