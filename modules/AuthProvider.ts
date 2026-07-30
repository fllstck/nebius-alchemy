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

export const NEBIUS_AUTH_PROVIDER_NAME = 'Nebius'
const STORAGE_KEY = 'nebius-stored'

export type NebiusAuthConfig = { method: 'env' } | { method: 'stored' } | { method: 'nebius-cli' }

/**
 * Credentials persisted to the Alchemy credential store.
 *
 * **⚠️ Security note:** Alchemy's {@link CredentialsStore} writes these
 * credentials as **unencrypted JSON** to
 * `~/.alchemy/credentials/{profile}/nebius-stored.json`. The `apiKey` field
 * is redacted in logs and console output (via {@link Redacted.make}), but
 * is stored as plaintext on disk.
 *
 * For production use, prefer the `nebius-cli` method (which uses short-lived
 * IAM tokens) or the `env` method (which reads from `NEBIUS_API_KEY` without
 * persisting to disk).
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
                  'Could not invoke `nebius`. Install Nebius CLI from https://docs.nebius.com/cli/install and run `nebius init`.',
                cause: e,
              }),
        ),
      )

    // Cached token source with TTL-based invalidation.
    // getRawToken() is called once to obtain the effect; cachedInvalidateWithTTL
    // memoizes its result for TOKEN_TTL, re-executing on expiry or manual invalidation.
    const [cachedToken, invalidateToken] = yield* Effect.cachedInvalidateWithTTL(getTokenViaCli(), TOKEN_TTL)

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
            hint: 'delegate to `nebius iam get-access-token` (run `nebius init` first)',
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
            Match.when('env', () => Effect.succeed({ method: 'env' as const })),
            Match.when('stored', () => loginStored(profileName)),
            Match.exhaustive,
          ),
        ),
      )

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) return { method: 'env' as const }
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
