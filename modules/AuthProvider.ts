import { AuthProviderLayer } from 'alchemy/Auth/AuthProvider'
import { CredentialsStore } from 'alchemy/Auth/Credentials'
import { Redacted } from 'effect'
import * as Effect from 'effect/Effect'
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
import * as OAuth from './auth/oauth.ts'
import { writeSecureCredentials } from './auth/secure-credentials.ts'

export const NEBIUS_AUTH_PROVIDER_NAME = 'Nebius'
const STORAGE_KEY = 'nebius-stored'
const SA_STORAGE_KEY = 'nebius-sa-key'
const OAUTH_STORAGE_KEY = 'nebius-oauth'

// Service-account key env vars (the non-interactive RFC 8693 exchange path).
const SA_ID_ENV = 'NEBIUS_SA_ID'
const SA_KEY_ID_ENV = 'NEBIUS_SA_KEY_ID'
const SA_PRIVATE_KEY_ENV = 'NEBIUS_SA_PRIVATE_KEY'
const SA_PRIVATE_KEY_FILE_ENV = 'NEBIUS_SA_PRIVATE_KEY_FILE'

export type NebiusAuthConfig =
  | { method: 'env' }
  | { method: 'stored' }
  | { method: 'sa-key' }
  | { method: 'oauth' }

/**
 * Credentials persisted to the Alchemy credential store.
 *
 * **⚠️ Security note:** Alchemy's {@link CredentialsStore} writes these
 * credentials as **unencrypted JSON** to
 * `~/.alchemy/credentials/{profile}/nebius-stored.json` — plaintext **and
 * world-readable unless chmod'd**. The `apiKey` field is redacted in logs
 * and console output (via {@link Redacted.make}), and the file is chmod'd
 * to 0600 after writing via `writeSecureCredentials`
 * (`modules/auth/secure-credentials.ts`).
 *
 * For production use, prefer the `oauth` method (browser login) or the
 * `sa-key` method (non-interactive RFC 8693 exchange, automatic renewal);
 * the `env` method reads `NEBIUS_API_KEY` without persisting to disk.
 */
export type NebiusStoredCredentials = {
  type: 'apiKey'
  apiKey: string
}

/**
 * OAuth credentials persisted by the browser login. No refresh token exists
 * for Nebius user accounts — the 12h token is re-issued by re-running
 * `alchemy login`. `projectId` records the project chosen at login.
 *
 * **⚠️ Security note:** plaintext JSON — **world-readable unless chmod'd**;
 * the file is chmod'd to 0600 after writing via `writeSecureCredentials`
 * (`modules/auth/secure-credentials.ts`).
 */
export type NebiusOAuthCredentials = {
  type: 'oauth'
  accessToken: string
  expiresAt: number
  tenantId: string
  projectId: string
}

/**
 * SA-key material persisted by the interactive bootstrap. The private key is
 * stored as plaintext JSON in the credential store — same trust model as
 * {@link NebiusStoredCredentials}; env vars override it for CI.
 * `projectId` records which project the SA was bootstrapped for, so a later
 * project change can be surfaced (and re-bootstrap offered) instead of
 * failing later with a confusing PermissionDenied.
 *
 * **⚠️ Security note:** plaintext RSA private key — **world-readable unless
 * chmod'd**; the file is chmod'd to 0600 after writing via
 * `writeSecureCredentials` (`modules/auth/secure-credentials.ts`).
 */
export type NebiusSaKeyCredentials = {
  type: 'saKey'
  serviceAccountId: string
  keyId: string
  privateKey: string
  projectId: string
}

export type NebiusResolvedCredentials = {
  type: 'apiKey'
  apiKey: Redacted.Redacted<string>
  source: { type: NebiusAuthConfig['method']; details?: string }
}

// Token TTL is not needed: OAuth reads the stored 12h token directly and
// sa-key mints per process (the outer `Effect.cached` in Credentials.ts
// memoizes the whole resolution).

export const NebiusAuth = AuthProviderLayer<NebiusAuthConfig, NebiusResolvedCredentials>()(
  NEBIUS_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const credentialStore = yield* CredentialsStore
    const saTokenMinter = yield* SaToken.SaTokenMinter
    const saBootstrap = yield* SaBootstrap.SaBootstrap

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

      // Bootstrap credential source: prefer the current browser (OAuth) login
      // when available, otherwise paste an API key — no external CLI needed.
      const storedOAuth = yield* credentialStore.read<NebiusOAuthCredentials>(profileName, OAUTH_STORAGE_KEY)
      const oauthAvailable = storedOAuth != null && storedOAuth.expiresAt > Date.now()

      const credSource = yield* Clank.select({
        message: 'Create the service account using',
        options: [
          ...(oauthAvailable
            ? [
                {
                  value: 'oauth' as const,
                  label: 'Nebius OAuth login',
                  hint: 'use the current browser login (recommended)',
                },
              ]
            : []),
          {
            value: 'apiKey' as const,
            label: 'API key',
            hint: 'paste a Nebius API key (one time)',
          },
        ],
      })

      const token: Redacted.Redacted<string> =
        credSource === 'oauth'
          ? Redacted.make(storedOAuth!.accessToken)
          : yield* Clank.password({
              message: 'Nebius API Key',
              validate: (v) => (v.length === 0 ? 'Required' : undefined),
            }).pipe(retryOnce, Effect.map((k) => Redacted.make(k)))

      // Best-effort project name so the prompts show the project name, not
      // just the opaque ID (falls back to the ID alone on any failure).
      const projectName = yield* saBootstrap.getProjectName(token, Redacted.value(projectId)).pipe(
        Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
      )
      const projectLabel = projectName ? `${projectName} (${Redacted.value(projectId)})` : Redacted.value(projectId)

      const saName = yield* Clank.text({
        message: 'Service account name',
        initialValue: 'nebius-alchemy-sa',
        validate: (v) => (v.length === 0 ? 'Required' : undefined),
      })

      const grantRole = yield* Clank.select({
        message: `Grant the SA a role on project ${projectLabel}?`,
        options: [
          {
            value: 'editor',
            label: 'editor',
            hint: 'manage resources (compute, storage, VPC, KMS…) — recommended',
          },
          {
            value: 'admin',
            label: 'admin',
            hint: 'full access incl. IAM, quotas, audit logs — needed when deploying IAM/quotas resources',
          },
        ],
      })

      const key = yield* saBootstrap
        .bootstrap(token, {
          parentId: Redacted.value(projectId),
          serviceAccountName: saName,
          grant: { role: grantRole, resourceId: Redacted.value(projectId) },
        })
        .pipe(Effect.mapError((e) => new AuthError({ message: e.message, cause: e })))

      yield* writeSecureCredentials(credentialStore, profileName, SA_STORAGE_KEY, {
        type: 'saKey',
        ...key,
        projectId: Redacted.value(projectId),
      })
      yield* Clank.success('Nebius: service-account key created and stored.')
      yield* Clank.info('To use in CI, set:')
      yield* Clank.info(`  NEBIUS_SA_ID=${key.serviceAccountId}`)
      yield* Clank.info(`  NEBIUS_SA_KEY_ID=${key.keyId}`)
      yield* Clank.info('  NEBIUS_SA_PRIVATE_KEY=<private key PEM>')
      return key
    })

    /**
     * Interactive browser OAuth login (Cloudflare-style, no CLI): start the
     * loopback callback server, open the authorize URL, then let the user
     * complete it in the browser (or paste the code/URL). Persists the 12h
     * token plus the project chosen from the user's project list.
     */
    const loginOAuth = Effect.fn('NebiusAuth.loginOAuth')(function* (profileName: string) {
      const { verifier, challenge, state } = OAuth.createPkce()
      const { port, waitForCode, close } = yield* OAuth.startCallbackServer(state).pipe(
        Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
      )
      const redirectUri = `http://127.0.0.1:${port}`
      const authorization: OAuth.OAuthAuthorization = { verifier, state, redirectUri }
      const url = OAuth.buildAuthorizeUrl({ challenge, state, redirectUri })

      yield* Clank.info('Nebius: opening browser for OAuth login...')
      yield* Clank.info(url)
      yield* Clank.openUrl(url).pipe(
        Effect.catch(() =>
          Clank.warn('Nebius: could not open browser automatically. Please open the URL above manually.'),
        ),
      )
      yield* Clank.info('Nebius: waiting for authorization (up to 5 minutes).')

      const credentials = yield* Effect.raceFirst(
        waitForCode.pipe(Effect.flatMap((code) => OAuth.exchangeCode(code, verifier, redirectUri))),
        Clank.text({
          message: 'Paste the authorization code or callback URL',
          placeholder: 'The browser will complete this automatically when local',
          validate: (value) => (value.trim().length > 0 ? undefined : 'Paste a code or URL'),
        }).pipe(Effect.flatMap((input) => OAuth.exchangeCallbackInput(input, authorization))),
      ).pipe(
        Effect.ensuring(close),
        Effect.mapError((e) => new AuthError({ message: `Nebius OAuth login failed: ${e.message}`, cause: e })),
      )

      // Tenant + project selection — Cloudflare's `selectAccount` analog.
      // The tenant comes from the token itself, so NEBIUS_TENANT_ID is NOT
      // required; env only wins later via the project-config fallback.
      const tenants = yield* SaBootstrap.listTenants(Redacted.make(credentials.accessToken)).pipe(
        Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
      )
      if (tenants.length === 0) {
        return yield* new AuthError({ message: 'No tenants found for the logged-in user.' })
      }
      const tenantId =
        tenants.length === 1
          ? (tenants[0]!.id)
          : yield* Clank.select({
              message: 'Select the tenant',
              options: tenants.map((t) => ({
                value: t.id,
                label: t.name || t.id,
                hint: t.name ? t.id : undefined,
              })),
            })

      const projects = yield* SaBootstrap.listProjects(Redacted.make(credentials.accessToken), tenantId).pipe(
        Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
      )
      if (projects.length === 0) {
        return yield* new AuthError({ message: 'No projects found for the logged-in user.' })
      }
      const projectId = yield* Clank.select({
        message: 'Select the project',
        options: projects.map((p) => ({
          value: p.id,
          label: p.name || p.id,
          hint: p.name ? p.id : undefined,
        })),
      })

      yield* writeSecureCredentials(credentialStore, profileName, OAUTH_STORAGE_KEY, {
        type: 'oauth',
        accessToken: credentials.accessToken,
        expiresAt: credentials.expiresAt,
        tenantId,
        projectId,
      })
      yield* Clank.success(`Nebius: logged in. Project: ${projectId}`)
      return { method: 'oauth' as const }
    })

    const loginStored = Effect.fn(function* (profileName: string) {
      const apiKey = yield* Clank.password({
        message: 'Nebius API Key',
        validate: (v) => (v.length === 0 ? 'Required' : undefined),
      }).pipe(retryOnce)

      yield* writeSecureCredentials(credentialStore, profileName, STORAGE_KEY, {
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
            value: 'oauth' as const,
            label: 'Nebius account (OAuth)',
            hint: 'browser-based login — no CLI, no service account',
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
            Match.when('oauth', () =>
              Effect.gen(function* () {
                // `--configure` means re-setup: always run the browser flow,
                // even when a valid token is already stored (mirrors the
                // Cloudflare provider's configureOAuth).
                yield* loginOAuth(profileName)
                return { method: 'oauth' as const }
              }).pipe(
                Effect.mapError(
                  (e) =>
                    new AuthError({
                      message: `Nebius OAuth not usable: ${e.message}`,
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
                  // If the material comes from the credential store and was
                  // bootstrapped for a DIFFERENT project than the current
                  // NEBIUS_PROJECT_ID, offer to re-bootstrap instead of
                  // failing later with a confusing PermissionDenied.
                  const projectId = yield* getEnvRedacted('NEBIUS_PROJECT_ID')
                  const fromEnv = yield* readSaKeyEnv()
                  if (projectId != null && fromEnv == null) {
                    const stored = yield* credentialStore.read<NebiusSaKeyCredentials>(profileName, SA_STORAGE_KEY)
                    if (stored != null && stored.projectId !== Redacted.value(projectId)) {
                      const action = yield* Clank.select({
                        message: `The stored service-account key is for project ${stored.projectId}, but NEBIUS_PROJECT_ID is ${Redacted.value(projectId)}.`,
                        options: [
                          {
                            value: 'keep' as const,
                            label: 'Use the existing key',
                            hint: 'the SA must already have access to the new project',
                          },
                          {
                            value: 'rebootstrap' as const,
                            label: 'Create a new key for this project',
                            hint: 'bootstraps a new SA + key + grant',
                          },
                        ],
                      })
                      if (action === 'rebootstrap') {
                        yield* bootstrapSaKey(profileName)
                        return { method: 'sa-key' as const }
                      }
                    }
                  }
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
      // Migration: pre-OAuth profiles may still store the removed
      // `nebius-cli` method — fail with clear guidance instead of a crash.
      (config as { method: string }).method === 'nebius-cli'
        ? Effect.fail(
            new AuthError({
              message: 'Nebius CLI authentication is no longer supported. Run: alchemy login',
            }),
          )
        : Match.value(config).pipe(
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
        Match.when({ method: 'oauth' }, () =>
          Effect.gen(function* () {
            const stored = yield* credentialStore.read<NebiusOAuthCredentials>(profileName, OAUTH_STORAGE_KEY)
            if (stored == null) {
              return yield* new AuthError({ message: 'Nebius OAuth credentials not found. Run: alchemy login' })
            }
            if (stored.expiresAt <= Date.now()) {
              return yield* new AuthError({ message: 'Nebius OAuth token expired. Run: alchemy login' })
            }
            return {
              type: 'apiKey' as const,
              apiKey: Redacted.make(stored.accessToken),
              source: { type: 'oauth' as const, details: stored.projectId },
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
        Match.when({ method: 'oauth' }, () =>
          Effect.gen(function* () {
            const stored = yield* credentialStore.read<NebiusOAuthCredentials>(profileName, OAUTH_STORAGE_KEY)
            if (stored != null && stored.expiresAt > Date.now()) {
              yield* Clank.success('Nebius: OAuth login valid.')
              return
            }
            yield* loginOAuth(profileName)
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
        Match.when({ method: 'sa-key' }, () =>
          credentialStore
            .delete(profileName, SA_STORAGE_KEY)
            .pipe(Effect.andThen(Clank.success('Nebius: SA-key credentials removed.'))),
        ),
        Match.when({ method: 'oauth' }, () =>
          credentialStore
            .delete(profileName, OAUTH_STORAGE_KEY)
            .pipe(Effect.andThen(Clank.success('Nebius: OAuth credentials removed.'))),
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
