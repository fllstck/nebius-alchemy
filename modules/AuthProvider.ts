import { AuthProviderLayer } from 'alchemy/Auth/AuthProvider'
import { CredentialsStore } from 'alchemy/Auth/Credentials'
import { Duration, Redacted } from 'effect'
import * as Effect from 'effect/Effect'
import {
  AuthError,
  NeedsReauth,
  reconfigureHint,
  refreshHint,
  type ConfigureMethod,
  type EnvironmentVariable,
  type ProviderDetails,
} from 'alchemy/Auth/AuthProvider'
import { getEnvRedacted, mapPromptCancellation } from 'alchemy/Auth/Env'
import { Interaction, openUrl } from 'alchemy/Interaction'
import * as Match from 'effect/Match'
import { displayRedacted } from 'alchemy/Auth/Credentials'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
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

/**
 * Persisted, user-editable provider configuration (the `values` object in the
 * v3 profile manifest). Decoded against {@link NebiusAuthConfigSchema} on every
 * load, so a file written by a newer or older alchemy fails with a
 * reconfigure hint instead of reaching provider code that matches exhaustively
 * on `method`.
 */
export const NebiusAuthConfigSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal('env') }),
  Schema.Struct({ method: Schema.Literal('stored') }),
  Schema.Struct({ method: Schema.Literal('sa-key') }),
  Schema.Struct({ method: Schema.Literal('oauth') }),
])

export type NebiusAuthConfig = typeof NebiusAuthConfigSchema.Type

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
export const NebiusStoredCredentialsSchema = Schema.Struct({
  type: Schema.Literal('apiKey'),
  apiKey: Schema.String,
})

export type NebiusStoredCredentials = typeof NebiusStoredCredentialsSchema.Type

/**
 * OAuth credentials persisted by the browser login. No refresh token exists
 * for Nebius user accounts — the 12h token is re-issued by re-running
 * `alchemy profile edit`. `projectId` records the project chosen at login.
 *
 * **⚠️ Security note:** plaintext JSON — **world-readable unless chmod'd**;
 * the file is chmod'd to 0600 after writing via `writeSecureCredentials`
 * (`modules/auth/secure-credentials.ts`).
 */
export const NebiusOAuthCredentialsSchema = Schema.Struct({
  type: Schema.Literal('oauth'),
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  tenantId: Schema.String,
  projectId: Schema.String,
})

export type NebiusOAuthCredentials = typeof NebiusOAuthCredentialsSchema.Type

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
export const NebiusSaKeyCredentialsSchema = Schema.Struct({
  type: Schema.Literal('saKey'),
  serviceAccountId: Schema.String,
  keyId: Schema.String,
  privateKey: Schema.String,
  projectId: Schema.String,
  /**
   * Tenant the project belongs to, captured at bootstrap so tenant-scoped
   * operations work without `NEBIUS_TENANT_ID` in the environment.
   *
   * Optional because keys bootstrapped before this was recorded lack it, and
   * stored credential documents must keep decoding (the whole point of the
   * schema). Absent → those operations fall back to the env var, which is the
   * historical behaviour.
   */
  tenantId: Schema.optional(Schema.String),
})

export type NebiusSaKeyCredentials = typeof NebiusSaKeyCredentialsSchema.Type

export type NebiusResolvedCredentials = {
  type: 'apiKey'
  apiKey: Redacted.Redacted<string>
  source: { type: NebiusAuthConfig['method']; details?: string }
}

// Token TTL is not needed: OAuth reads the stored 12h token directly and
// sa-key mints per process (the outer `Effect.cached` in Credentials.ts
// memoizes the whole resolution).

/**
 * The CI environment contract — the variables {@link readEnvironment} consumes
 * that may be probed for PRESENCE. Names only; never values.
 *
 * ⚠️ Alchemy uses this list as the env-vs-profile precedence probe
 * (`presentEnvironment`, `Auth/Demand.ts`, `Auth/Resolve.ts`): the environment
 * credential source is selected as soon as ANY entry here is present (unless a
 * `required` one is missing). So an entry is only safe here if **its presence by
 * itself implies usable credentials** — otherwise it hijacks resolution away
 * from a perfectly good profile.
 *
 * `NEBIUS_PROJECT_ID` was
 * removed for exactly that reason: with it in the environment (every example's
 * `.env`) alchemy reported "using environment variables (NEBIUS_PROJECT_ID)
 * instead of the profile" and then died in `readEnvironment` with "CI
 * credentials not found", because no credential variable was set at all. That
 * broke provider *loading*, so `alchemy profile edit --add Nebius` could not run
 * on a machine that had a project id but no credentials yet.
 *
 * The service-account variables are deliberately **absent too**, and that is the
 * subtle part: `EnvironmentVariable.required` is a per-variable boolean, so this
 * contract can express "all of these" and "any of these" but NOT our actual
 * rule — "`NEBIUS_API_KEY` **or** all three SA variables". Listing them with
 * `required: false` made any single one count as configured, so a half-set group
 * (e.g. only `NEBIUS_SA_ID`) hijacked resolution and killed provider loading
 * the same way the project id did. Verified before and after.
 *
 * Consequence, accepted deliberately: **SA-key credentials from the environment
 * are CI-only.** In CI alchemy bypasses this probe entirely (`CI=true` → it
 * calls `readEnvironment` directly), so the full SA flow still works there. A
 * local, non-CI run must use a profile instead.
 *
 * `readEnvironment` still *consumes* the SA variables and documents them in its
 * error message — this list governs probing, not capability.
 */
export const nebiusEnvironment: ReadonlyArray<EnvironmentVariable> = [
  {
    name: 'NEBIUS_API_KEY',
    required: false,
    secret: true,
    description: 'Static Nebius API key. Takes precedence over all service-account variables.',
  },
]

/**
 * The non-interactive (`--method` / `--set`) configuration surface. Browser
 * OAuth is interactive-only, so it is deliberately absent.
 */
const configureMethods: ReadonlyArray<ConfigureMethod> = [
  {
    method: 'stored',
    fields: [
      {
        name: 'apiKey',
        label: 'Nebius API Key',
        secret: true,
      },
    ],
  },
  { method: 'env', fields: [] },
  { method: 'sa-key', fields: [] },
]

export const NebiusAuth = AuthProviderLayer<NebiusAuthConfig, NebiusResolvedCredentials>()(
  NEBIUS_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const credentialStore = yield* CredentialsStore
    const saTokenMinter = yield* SaToken.SaTokenMinter
    const saBootstrap = yield* SaBootstrap.SaBootstrap

    /**
     * Narrow a mixed failure to `AuthError`. Credential writes can fail with a
     * `PlatformError` (the post-write `chmod 0600` in
     * `writeSecureCredentials`), but the auth-provider contract admits only
     * `AuthError`/`NeedsReauth` on the interactive methods.
     */
    const toAuthError = (cause: unknown): AuthError =>
      cause instanceof AuthError
        ? cause
        : new AuthError({ message: 'Nebius credentials could not be saved', cause })

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

      const stored = yield* credentialStore.read(profileName, SA_STORAGE_KEY, NebiusSaKeyCredentialsSchema)
      if (stored) {
        return {
          serviceAccountId: stored.serviceAccountId,
          keyId: stored.keyId,
          privateKey: stored.privateKey,
        }
      }

      return yield* new AuthError({
        message:
          'Nebius service-account key credentials not found. ' +
          'Set NEBIUS_SA_ID / NEBIUS_SA_KEY_ID / NEBIUS_SA_PRIVATE_KEY for CI. ' +
          reconfigureHint(NEBIUS_AUTH_PROVIDER_NAME, profileName),
      })
    })

    /**
     * Interactive bootstrap: create SA + key (+ optional grant) using a
     * one-time bootstrap credential, then persist the material.
     */
    const bootstrapSaKey = Effect.fn('NebiusAuth.bootstrapSaKey')(function* (
      profileName: string,
    ) {
      const interaction = yield* Interaction
      const projectId = yield* getEnvRedacted('NEBIUS_PROJECT_ID')
      if (!projectId) {
        return yield* new AuthError({ message: 'Set NEBIUS_PROJECT_ID to bootstrap a service account.' })
      }

      yield* interaction.output.info('No Nebius service-account key found — bootstrapping one now.')

      // Bootstrap credential source: prefer the current browser (OAuth) login
      // when available, otherwise paste an API key — no external CLI needed.
      const storedOAuth = yield* credentialStore.read(profileName, OAUTH_STORAGE_KEY, NebiusOAuthCredentialsSchema)
      const oauthAvailable = storedOAuth != null && storedOAuth.expiresAt > Date.now()

      const credSource = yield* interaction.prompt
        .select({
          message: 'Create the service account using',
          options: [
            ...(oauthAvailable
              ? [
                  {
                    value: 'oauth' as const,
                    label: 'Nebius OAuth login',
                    description: 'use the current browser login (recommended)',
                  },
                ]
              : []),
            {
              value: 'apiKey' as const,
              label: 'API key',
              description: 'paste a Nebius API key (one time)',
            },
          ],
        })
        .pipe(mapPromptCancellation)

      const token: Redacted.Redacted<string> =
        credSource === 'oauth'
          ? Redacted.make(storedOAuth!.accessToken)
          : Redacted.make(
              yield* interaction.prompt
                .password({
                  message: 'Nebius API Key',
                  validate: (v) => (v.length === 0 ? 'Required' : undefined),
                })
                .pipe(mapPromptCancellation),
            )

      // Best-effort project lookup: gives friendlier prompts (name, not just
      // the opaque ID) and captures the tenant, so tenant-scoped operations
      // (project fan-out, `alchemy unsafe nuke`, discovery actions) work later
      // without the user having to set NEBIUS_TENANT_ID.
      const projectDetails = yield* saBootstrap.getProjectDetails(token, Redacted.value(projectId)).pipe(
        Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
      )
      const projectLabel = projectDetails.name
        ? `${projectDetails.name} (${Redacted.value(projectId)})`
        : Redacted.value(projectId)

      const saName = yield* interaction.prompt
        .text({
          message: 'Service account name',
          initialValue: 'nebius-alchemy-sa',
          validate: (v) => (v.length === 0 ? 'Required' : undefined),
        })
        .pipe(mapPromptCancellation)

      const grantRole = yield* interaction.prompt
        .select({
          message: `Grant the SA a role on project ${projectLabel}?`,
          options: [
            {
              value: 'editor',
              label: 'editor',
              description: 'manage resources (compute, storage, VPC, KMS…) — recommended',
            },
            {
              value: 'admin',
              label: 'admin',
              description: 'full access incl. IAM, quotas, audit logs — needed when deploying IAM/quotas resources',
            },
          ],
        })
        .pipe(mapPromptCancellation)

      const key = yield* saBootstrap
        .bootstrap(token, {
          parentId: Redacted.value(projectId),
          serviceAccountName: saName,
          grant: { role: grantRole, resourceId: Redacted.value(projectId) },
        })
        .pipe(Effect.mapError((e) => new AuthError({ message: e.message, cause: e })))

      yield* writeSecureCredentials(credentialStore, profileName, SA_STORAGE_KEY, NebiusSaKeyCredentialsSchema, {
        type: 'saKey',
        ...key,
        projectId: Redacted.value(projectId),
        ...(projectDetails.tenantId ? { tenantId: projectDetails.tenantId } : {}),
      })
      yield* interaction.output.success('Nebius: service-account key created and stored.')
      yield* interaction.output.info('To use in CI, set:')
      yield* interaction.output.info(`  NEBIUS_SA_ID=${key.serviceAccountId}`)
      yield* interaction.output.info(`  NEBIUS_SA_KEY_ID=${key.keyId}`)
      yield* interaction.output.info('  NEBIUS_SA_PRIVATE_KEY=<private key PEM>')
      return key
    })

    /**
     * Interactive browser OAuth login (Cloudflare-style, no CLI): start the
     * loopback callback server, open the authorize URL, then let the user
     * complete it in the browser (or paste the code/URL). Persists the 12h
     * token plus the project chosen from the user's project list.
     */
    const loginOAuth = Effect.fn('NebiusAuth.loginOAuth')(function* (profileName: string) {
      const interaction = yield* Interaction
      const { verifier, challenge, state } = OAuth.createPkce()
      const clientId = yield* Effect.sync(OAuth.resolveClientId)
      const { port, waitForCode, close } = yield* OAuth.startCallbackServer(state).pipe(
        Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
      )
      const redirectUri = `http://127.0.0.1:${port}`
      const authorization: OAuth.OAuthAuthorization = { verifier, state, redirectUri, clientId }
      const url = OAuth.buildAuthorizeUrl({ challenge, state, redirectUri, clientId })

      yield* interaction.output.info(`Nebius: authenticating with OAuth client ${clientId}`)
      yield* interaction.output.info('Nebius: opening browser for OAuth login...')
      yield* interaction.output.info(url)
      yield* openUrl(url).pipe(
        Effect.catch(() =>
          interaction.output.warning('Nebius: could not open browser automatically. Please open the URL above manually.'),
        ),
      )
      yield* interaction.output.info('Nebius: waiting for authorization (up to 5 minutes).')

      const credentials = yield* Effect.raceFirst(
        waitForCode.pipe(Effect.flatMap((code) => OAuth.exchangeCode(code, verifier, redirectUri, clientId))),
        interaction.prompt
          .text({
            message: 'Paste the authorization code or callback URL',
            placeholder: 'The browser will complete this automatically when local',
            validate: (value) => (value.trim().length > 0 ? undefined : 'Paste a code or URL'),
          })
          .pipe(
            mapPromptCancellation,
            Effect.flatMap((input) => OAuth.exchangeCallbackInput(input, authorization)),
          ),
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
          : yield* interaction.prompt
              .select({
                message: 'Select the tenant',
                options: tenants.map((t) => ({
                  value: t.id,
                  label: t.name || t.id,
                  description: t.name ? t.id : undefined,
                })),
              })
              .pipe(mapPromptCancellation)

      const projects = yield* SaBootstrap.listProjects(Redacted.make(credentials.accessToken), tenantId).pipe(
        Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
      )
      if (projects.length === 0) {
        return yield* new AuthError({ message: 'No projects found for the logged-in user.' })
      }
      const projectId = yield* interaction.prompt
        .select({
          message: 'Select the project',
          options: projects.map((p) => ({
            value: p.id,
            label: p.name || p.id,
            description: p.name ? p.id : undefined,
          })),
        })
        .pipe(mapPromptCancellation)

      yield* writeSecureCredentials(credentialStore, profileName, OAUTH_STORAGE_KEY, NebiusOAuthCredentialsSchema, {
        type: 'oauth',
        accessToken: credentials.accessToken,
        expiresAt: credentials.expiresAt,
        tenantId,
        projectId,
      })
      yield* interaction.output.success(`Nebius: logged in. Project: ${projectId}`)
      return { method: 'oauth' as const }
    })

    const loginStored = Effect.fn('NebiusAuth.loginStored')(function* (profileName: string) {
      const interaction = yield* Interaction
      const apiKey = yield* interaction.prompt
        .password({
          message: 'Nebius API Key',
          validate: (v) => (v.length === 0 ? 'Required' : undefined),
        })
        .pipe(mapPromptCancellation)

      yield* writeSecureCredentials(credentialStore, profileName, STORAGE_KEY, NebiusStoredCredentialsSchema, {
        type: 'apiKey',
        apiKey,
      })
      yield* interaction.output.success('Nebius: credentials saved.')
      return { method: 'stored' as const }
    })

    const configureInteractive = Effect.fn('NebiusAuth.configureInteractive')(function* (
      profileName: string,
      currentConfig?: NebiusAuthConfig,
    ) {
      const interaction = yield* Interaction
      const method = yield* interaction.prompt
        .select({
          message: 'Nebius authentication method',
          initialValue: currentConfig?.method,
          options: [
            {
              value: 'oauth' as const,
              label: 'Nebius account (OAuth)',
              description: 'browser-based login — no CLI, no service account',
            },
            {
              value: 'sa-key' as const,
              label: 'Service Account Key',
              description: `non-interactive RFC 8693 exchange — set ${SA_ID_ENV} + ${SA_KEY_ID_ENV} + private key`,
            },
            { value: 'env' as const, label: 'Environment Variable', description: 'NEBIUS_API_KEY' },
            {
              value: 'stored' as const,
              label: 'API Key',
              description: 'enter interactively, stored in ~/.alchemy/credentials',
            },
          ],
        })
        .pipe(mapPromptCancellation)

      return yield* Match.value(method).pipe(
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
                const stored = yield* credentialStore.read(profileName, SA_STORAGE_KEY, NebiusSaKeyCredentialsSchema)
                if (stored != null && stored.projectId !== Redacted.value(projectId)) {
                  const action = yield* interaction.prompt
                    .select({
                      message: `The stored service-account key is for project ${stored.projectId}, but NEBIUS_PROJECT_ID is ${Redacted.value(projectId)}.`,
                      options: [
                        {
                          value: 'keep' as const,
                          label: 'Use the existing key',
                          description: 'the SA must already have access to the new project',
                        },
                        {
                          value: 'rebootstrap' as const,
                          label: 'Create a new key for this project',
                          description: 'bootstraps a new SA + key + grant',
                        },
                      ],
                    })
                    .pipe(mapPromptCancellation)
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
      )
    })

    /**
     * Interactive configuration. `currentConfig` (when present) is the
     * previously stored method, used only to pre-select the prompt.
     *
     * CI is deliberately NOT special-cased here: unattended runs resolve
     * through {@link readEnvironment} / the `env` method, never through a
     * prompt. This method always requires {@link Interaction}.
     */
    const configure = (profileName: string, currentConfig?: NebiusAuthConfig) =>
      configureInteractive(profileName, currentConfig).pipe(Effect.mapError(toAuthError))

    /**
     * Flag-driven configuration for scripts and agents
     * (`alchemy profile edit --set …`). Browser OAuth is intentionally absent.
     */
    const configureWithImpl = Effect.fn('NebiusAuth.configureWith')(function* (
      profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) {
      switch (input.method) {
        case 'stored': {
          const apiKey = input.values.apiKey
          if (apiKey == null || apiKey.length === 0) {
            return yield* new AuthError({ message: 'Missing required --set apiKey=<value> for method "stored".' })
          }
          yield* writeSecureCredentials(credentialStore, profileName, STORAGE_KEY, NebiusStoredCredentialsSchema, {
            type: 'apiKey',
            apiKey,
          })
          return { method: 'stored' as const }
        }
        case 'env':
          return { method: 'env' as const }
        case 'sa-key': {
          // Non-interactive: the key material must already be in the
          // environment (validated on first use by `read`).
          const material = yield* readSaKey(profileName)
          yield* saTokenMinter.mint(material).pipe(
            Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
          )
          return { method: 'sa-key' as const }
        }
        default:
          return yield* new AuthError({
            message: `Nebius: unknown --method "${input.method}". Use one of: stored, env, sa-key.`,
          })
      }
    })

    const configureWith = (
      profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) => configureWithImpl(profileName, input).pipe(Effect.mapError(toAuthError))

    /**
     * Resolve credentials from the process environment only — never creates,
     * selects, or mutates a profile. This is the CI path: profiles do not
     * exist in CI, so this is the provider's entire CI contract.
     *
     * MUST stay non-interactive (no `Interaction` in `R`).
     */
    const readEnvironment = Effect.gen(function* () {
      // Static API key wins outright — it needs no project or key material.
      const apiKey = yield* getEnvRedacted('NEBIUS_API_KEY')
      if (apiKey) {
        return {
          type: 'apiKey' as const,
          apiKey,
          source: { type: 'env' as const },
        }
      }

      // Otherwise the RFC 8693 service-account key exchange.
      const key = yield* readSaKeyEnv()
      if (key) {
        const token = yield* saTokenMinter.mint(key).pipe(
          Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
        )
        return {
          type: 'apiKey' as const,
          apiKey: Redacted.make(token),
          source: { type: 'sa-key' as const, details: key.serviceAccountId },
        }
      }

      // Nothing usable. Name the missing pieces when the service-account group is
      // the cause: a half-set group is the most confusing way to arrive here, and
      // it deliberately cannot be detected from `nebiusEnvironment` (see the
      // comment there), so the error message is the only place it surfaces.
      const saVars = [SA_ID_ENV, SA_KEY_ID_ENV, SA_PRIVATE_KEY_ENV, SA_PRIVATE_KEY_FILE_ENV]
      const saPresent = (yield* Effect.forEach(saVars, (name) =>
        getEnvRedacted(name).pipe(Effect.map((value) => (value != null ? [name] : []))),
      )).flat()
      const incomplete =
        saPresent.length > 0
          ? ` The service-account group is incomplete — set: ${saPresent.join(', ')}; required: ${SA_ID_ENV} + ${SA_KEY_ID_ENV} + (${SA_PRIVATE_KEY_ENV} or ${SA_PRIVATE_KEY_FILE_ENV}).`
          : ''

      return yield* new AuthError({
        message:
          'Nebius CI credentials not found. Set NEBIUS_API_KEY, or NEBIUS_SA_ID + NEBIUS_SA_KEY_ID + NEBIUS_SA_PRIVATE_KEY (or NEBIUS_SA_PRIVATE_KEY_FILE).' +
          incomplete,
      })
    })

    const resolveCredentials = (
      profileName: string,
      config: NebiusAuthConfig,
    ): Effect.Effect<NebiusResolvedCredentials, AuthError | NeedsReauth> =>
      // Migration: pre-OAuth profiles may still store the removed
      // `nebius-cli` method — fail with clear guidance instead of a crash.
      (config as { method: string }).method === 'nebius-cli'
        ? Effect.fail(
            new AuthError({
              message:
                'Nebius CLI authentication is no longer supported. ' +
                reconfigureHint(NEBIUS_AUTH_PROVIDER_NAME, profileName),
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
                const stored = yield* credentialStore.read(profileName, OAUTH_STORAGE_KEY, NebiusOAuthCredentialsSchema)
                if (stored == null) {
                  return yield* new NeedsReauth({
                    provider: NEBIUS_AUTH_PROVIDER_NAME,
                    profile: profileName,
                    message:
                      'Nebius OAuth credentials not found. ' +
                      reconfigureHint(NEBIUS_AUTH_PROVIDER_NAME, profileName),
                  })
                }
                if (stored.expiresAt <= Date.now()) {
                  return yield* new NeedsReauth({
                    provider: NEBIUS_AUTH_PROVIDER_NAME,
                    profile: profileName,
                    message:
                      'Nebius OAuth token expired. ' +
                      refreshHint(NEBIUS_AUTH_PROVIDER_NAME, profileName),
                  })
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
              credentialStore.read(profileName, STORAGE_KEY, NebiusStoredCredentialsSchema).pipe(
                Effect.flatMap((creds) =>
                  creds == null
                    ? Effect.fail(
                        new NeedsReauth({
                          provider: NEBIUS_AUTH_PROVIDER_NAME,
                          profile: profileName,
                          message:
                            'Nebius stored credentials not found. ' +
                            reconfigureHint(NEBIUS_AUTH_PROVIDER_NAME, profileName),
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
            const interaction = yield* Interaction
            const existing = yield* readSaKey(profileName).pipe(Effect.result)
            const key = Result.isSuccess(existing) ? existing.success : yield* bootstrapSaKey(profileName)
            yield* saTokenMinter.mint(key).pipe(
              Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
            )
            yield* interaction.output.success('Nebius: service-account key available.')
          }),
        ),
        Match.when({ method: 'oauth' }, () =>
          Effect.gen(function* () {
            const interaction = yield* Interaction
            const stored = yield* credentialStore.read(profileName, OAUTH_STORAGE_KEY, NebiusOAuthCredentialsSchema)
            if (stored != null && stored.expiresAt > Date.now()) {
              yield* interaction.output.success('Nebius: OAuth login valid.')
              return
            }
            yield* loginOAuth(profileName)
          }),
        ),
        Match.when({ method: 'stored' }, () =>
          credentialStore
            .read(profileName, STORAGE_KEY, NebiusStoredCredentialsSchema)
            .pipe(Effect.flatMap((creds) => (creds == null ? loginStored(profileName) : Effect.void))),
        ),
        Match.exhaustive,
        Effect.mapError((e) => new AuthError({ message: 'login failed', cause: e })),
      )

    const logout = (profileName: string, config: NebiusAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: 'env' }, () => Effect.void),
        Match.when({ method: 'sa-key' }, () =>
          Effect.gen(function* () {
            const interaction = yield* Interaction
            // Deactivate the authorized key server-side BEFORE deleting local
            // material: the stored private key is the only way to mint a token
            // for this SA, so the deactivation must happen first. Best-effort —
            // a failure (network, missing IAM grant, already-deactivated key)
            // only warns and still clears the local credentials.
            const stored = yield* credentialStore.read(profileName, SA_STORAGE_KEY, NebiusSaKeyCredentialsSchema)
            if (stored) {
              const key: SaToken.SaKey = {
                serviceAccountId: stored.serviceAccountId,
                keyId: stored.keyId,
                privateKey: stored.privateKey,
              }
              yield* saTokenMinter
                .mint(key)
                .pipe(
                  Effect.flatMap((token) => saBootstrap.deactivateKey(Redacted.make(token), stored.keyId)),
                  Effect.mapError((e) => new AuthError({ message: e.message, cause: e })),
                  Effect.timeoutOrElse({
                    duration: Duration.seconds(45),
                    orElse: () => Effect.fail(new AuthError({ message: 'Timed out waiting for key deactivation.' })),
                  }),
                  Effect.matchEffect({
                    onSuccess: () =>
                      interaction.output.success(`Nebius: authorized key ${stored.keyId} deactivated on the server.`),
                    onFailure: (e) =>
                      interaction.output.warning(
                        `Nebius: could not deactivate authorized key ${stored.keyId} on the server (${e.message}). Removing local credentials only.`,
                      ),
                  }),
                )
            }
            yield* credentialStore.delete(profileName, SA_STORAGE_KEY)
            yield* interaction.output.success('Nebius: SA-key credentials removed.')
          }),
        ),
        Match.when({ method: 'oauth' }, () =>
          Effect.gen(function* () {
            const interaction = yield* Interaction
            yield* credentialStore.delete(profileName, OAUTH_STORAGE_KEY)
            yield* interaction.output.success('Nebius: OAuth credentials removed.')
          }),
        ),
        Match.when({ method: 'stored' }, () =>
          Effect.gen(function* () {
            const interaction = yield* Interaction
            yield* credentialStore.delete(profileName, STORAGE_KEY)
            yield* interaction.output.success('Nebius: stored credentials removed')
          }),
        ),
        Match.exhaustive,
      )

    /**
     * Structured credential details for `alchemy profile show`. Replaces the
     * removed `prettyPrint` Console-capture contract. Non-interactive — no
     * `Interaction` in `R`.
     */
    const details = (
      profileName: string,
      config: NebiusAuthConfig,
    ): Effect.Effect<ProviderDetails, AuthError | NeedsReauth> =>
      resolveCredentials(profileName, config).pipe(
        Effect.map((creds) => {
          const sourceStr = creds.source.details
            ? `${creds.source.type} - ${creds.source.details}`
            : creds.source.type
          return {
            lines: [
              { key: 'apiKey', value: displayRedacted(creds.apiKey, 7) },
              { key: 'source', value: sourceStr },
            ],
          }
        }),
      )

    return {
      configSchema: NebiusAuthConfigSchema,
      configure,
      configureWith,
      configureMethods,
      login,
      logout,
      details,
      read: resolveCredentials,
      readEnvironment,
      environment: nebiusEnvironment,
    }
  }),
)
