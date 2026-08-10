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
import * as Result from 'effect/Result'
import { readFile } from 'node:fs/promises'

import * as SaToken from './auth/sa-token.ts'
import * as SaBootstrap from './auth/sa-bootstrap.ts'

export const NEBIUS_AUTH_PROVIDER_NAME = 'Nebius'
const STORAGE_KEY = 'nebius-stored'
const SA_STORAGE_KEY = 'nebius-sa-key'

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

/**
 * SA-key material persisted by the interactive bootstrap. The private key is
 * stored as plaintext JSON in the credential store — same trust model as
 * {@link NebiusStoredCredentials}; env vars override it for CI.
 */
export type NebiusSaKeyCredentials = {
  type: 'saKey'
  serviceAccountId: string
  keyId: string
  privateKey: string
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
    const saBootstrap = yield* SaBootstrap.SaBootstrap

    const getTokenViaCli = (): Effect.Effect<string, AuthError> =>
      Effect.gen(function* () {
        const handle = yield* childProcessSpawner.spawn(
          // `--no-browser` suppresses the popup; `--auth-timeout 30s` bounds
          // the interactive OAuth flow so an expired CLI token fails in ~30s
          // instead of blocking up to the CLI's default 15-minute timeout.
          ChildProcess.make('nebius', ['iam', 'get-access-token', '--no-browser', '--auth-timeout', '30s'], {
            shell: false,
          }),
        )
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
          ],
          { concurrency: 3 },
        )
        if (exitCode !== 0) {
          const out = stderr.trim() || stdout.trim()
          const authHint = /(authentication|authorize|auth\.nebius|get code|deadline exceeded|complete the authentication)/i.test(
            out,
          )
            ? ' — Nebius CLI authentication is required or expired. Run `nebius profile create` + `nebius iam login`, or use the sa-key method (recommended).'
            : ''
          return yield* new AuthError({
            message: `nebius iam get-access-token exited with ${exitCode}: ${out}${authHint}`,
          })
        }

        const token = stdout.trim()
        if (!token) return yield* new AuthError({ message: 'nebius iam get-access-token returned empty output' })

        return token
      }).pipe(
        Effect.scoped,
        // Version-independent backstop: even if a future CLI ignores the
        // flags, an expired-token auth flow can never hang the deploy.
        Effect.timeoutOrElse({
          duration: '45 seconds',
          orElse: () =>
            Effect.fail(
              new AuthError({
                message:
                  'nebius iam get-access-token timed out — Nebius CLI authentication is required or expired. Run `nebius profile create` + `nebius iam login`, or use the sa-key method (recommended).',
              }),
            ),
        }),
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
    const readSaKeyEnv = Effect.fn('NebiusAuth.readSaKeyEnv')(function* (): Effect.fn.Return<
      SaToken.SaKey | undefined,
      AuthError
    > {
      const serviceAccountId = yield* getEnvRedacted(SA_ID_ENV)
      const keyId = yield* getEnvRedacted(SA_KEY_ID_ENV)
      const privateKeyValue = yield* getEnvRedacted(SA_PRIVATE_KEY_ENV)
      const privateKeyFile = yield* getEnvRedacted(SA_PRIVATE_KEY_FILE_ENV)

      if (serviceAccountId == null || keyId == null || (privateKeyValue == null && privateKeyFile == null)) {
        return undefined
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
        return undefined
      }

      return {
        serviceAccountId: Redacted.value(serviceAccountId),
        keyId: Redacted.value(keyId),
        privateKey,
      }
    })

    /**
     * Resolve SA-key material: env vars first (CI override), then the
     * credential store (written by the interactive bootstrap).
     */
    const readSaKey = Effect.fn('NebiusAuth.readSaKey')(function* (
      profileName: string,
    ): Effect.fn.Return<SaToken.SaKey, AuthError> {
      const fromEnv = yield* readSaKeyEnv()
      if (fromEnv) return fromEnv

      const stored = yield* credentialStore.read<NebiusSaKeyCredentials>(profileName, SA_STORAGE_KEY)
      if (stored) {
        return {
          serviceAccountId: stored.serviceAccountId,
          keyId: stored.keyId,
          privateKey: stored.privateKey,
        }
      }

      return yield* new AuthError({
        message:
          'Nebius service-account key credentials not found. Run `alchemy login` and pick "Service Account Key" to bootstrap one, or set NEBIUS_SA_ID / NEBIUS_SA_KEY_ID / NEBIUS_SA_PRIVATE_KEY.',
      })
    })

    /**
     * Interactive bootstrap: create SA + key (+ optional grant) using a
     * one-time bootstrap credential, then persist the material.
     */
    const bootstrapSaKey = Effect.fn('NebiusAuth.bootstrapSaKey')(function* (
      profileName: string,
    ) {
      const projectId = yield* getEnvRedacted('NEBIUS_PROJECT_ID')
      if (!projectId) {
        return yield* new AuthError({ message: 'Set NEBIUS_PROJECT_ID to bootstrap a service account.' })
      }

      yield* Clank.info('No Nebius service-account key found — bootstrapping one now.')

      const credSource = yield* Clank.select({
        message: 'Create the service account using',
        options: [
          {
            value: 'cli' as const,
            label: 'Nebius CLI login',
            hint: 'uses your existing `nebius` CLI session (one time)',
          },
          {
            value: 'apiKey' as const,
            label: 'API key',
            hint: 'paste a Nebius API key (one time)',
          },
        ],
      })

      const token: Redacted.Redacted<string> =
        credSource === 'cli'
          ? yield* cachedToken.pipe(
              Effect.map((t) => Redacted.make(t)),
              Effect.mapError(
                (e) =>
                  new AuthError({
                    message: `Nebius CLI not available: ${e.message}`,
                    cause: e,
                  }),
              ),
            )
          : yield* Clank.password({
              message: 'Nebius API Key',
              validate: (v) => (v.length === 0 ? 'Required' : undefined),
            }).pipe(retryOnce, Effect.map((k) => Redacted.make(k)))

      const saName = yield* Clank.text({
        message: 'Service account name',
        initialValue: 'nebius-alchemy-sa',
        validate: (v) => (v.length === 0 ? 'Required' : undefined),
      })

      const grant = yield* Clank.confirm({
        message: `Grant this SA access to project ${Redacted.value(projectId)}?`,
        initialValue: true,
      })

      const key = yield* saBootstrap
        .bootstrap(token, {
          parentId: Redacted.value(projectId),
          serviceAccountName: saName,
          ...(grant ? { grant: { role: 'admin', resourceId: Redacted.value(projectId) } } : {}),
        })
        .pipe(Effect.mapError((e) => new AuthError({ message: e.message, cause: e })))

      yield* credentialStore.write<NebiusSaKeyCredentials>(profileName, SA_STORAGE_KEY, {
        type: 'saKey',
        ...key,
      })
      yield* Clank.success('Nebius: service-account key created and stored.')
      yield* Clank.info('To use in CI, set:')
      yield* Clank.info(`  NEBIUS_SA_ID=${key.serviceAccountId}`)
      yield* Clank.info(`  NEBIUS_SA_KEY_ID=${key.keyId}`)
      yield* Clank.info('  NEBIUS_SA_PRIVATE_KEY=<private key PEM>')
      return key
    })

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
              Effect.gen(function* () {
                // Material already present (env or store) → validate by minting.
                const existing = yield* readSaKey(profileName).pipe(Effect.result)
                if (Result.isSuccess(existing)) {
                  yield* saTokenMinter.mint(existing.success)
                  return { method: 'sa-key' as const }
                }
                // Otherwise bootstrap interactively (one-time).
                yield* bootstrapSaKey(profileName)
                return { method: 'sa-key' as const }
              }).pipe(
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
          Effect.gen(function* () {
            const key = yield* readSaKey(profileName)
            const token = yield* saTokenMinter.mint(key).pipe(
              Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
            )
            return {
              type: 'apiKey' as const,
              apiKey: Redacted.make(token),
              source: { type: 'sa-key' as const, details: key.serviceAccountId },
            }
          }),
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
          Effect.gen(function* () {
            const existing = yield* readSaKey(profileName).pipe(Effect.result)
            const key = Result.isSuccess(existing) ? existing.success : yield* bootstrapSaKey(profileName)
            yield* saTokenMinter.mint(key).pipe(
              Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
            )
            yield* Clank.success('Nebius: service-account key available.')
          }),
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
          credentialStore
            .delete(profileName, SA_STORAGE_KEY)
            .pipe(Effect.andThen(Clank.success('Nebius: SA-key credentials removed.'))),
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
