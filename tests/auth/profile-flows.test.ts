/**
 * The provider methods behind alchemy's `profile` commands — `configure`/`configureWith`
 * (`create`, `edit --reconfigure`), `login` (`refresh`), `logout` (`delete`) and `details`
 * (`show`), plus the CI-only `readEnvironment`. In other words: everything a user does to set up
 * or renew Nebius credentials, and everything CI resolves them with.
 *
 * Neither method had any coverage before this file: the interactive paths need `Interaction`
 * (prompt answers) and the credential writes need an isolated home, and the existing
 * `AuthProvider.test.ts` drives the *non*-interactive contract (`read`, the env probe, logout)
 * with `layerNonInteractive`.
 *
 * Two pieces of harness make those paths reachable without a terminal or a browser:
 *
 * - **`ALCHEMY_HOME` points at a temp dir.** Alchemy resolves it lazily ("an override set after
 *   module load still takes effect"), so the real `~/.alchemy` is never touched and the
 *   persisted documents can be asserted as files — including their 0600 mode, which is the
 *   whole point of `writeSecureCredentials`.
 * - **A scripted `Interaction`**: prompt answers come from a queue and every message is
 *   recorded, so a test asserts both what the flow asked and what it narrated. An *unscripted*
 *   prompt dies with its own text, so a changed flow cannot pass by accident.
 *
 * Deliberately out of scope here: the browser arm of `loginOAuth` (a local callback server plus
 * `openUrl`, which would spawn a real browser) — that belongs with the HTTP double for
 * `auth/oauth.ts`'s token exchange.
 */
import * as BunTest from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import type { PlatformError } from 'effect/PlatformError'
import * as PlatformNode from '@effect/platform-node'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import {
  AuthError,
  AuthProviders,
  getAuthProvider,
  NeedsReauth,
  type ProviderDetails,
} from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import { Interaction } from 'alchemy/Interaction'
import * as Schema from 'effect/Schema'

import {
  NebiusAuth,
  NEBIUS_AUTH_PROVIDER_NAME,
  NebiusSaKeyCredentialsSchema,
  type NebiusAuthConfig,
  type NebiusResolvedCredentials,
} from '../../modules/AuthProvider.ts'
import * as SaBootstrap from '../../modules/auth/sa-bootstrap.ts'
import * as SaToken from '../../modules/auth/sa-token.ts'

const { afterAll, describe, expect, test } = BunTest

// ---------------------------------------------------------------------------
// Isolated home
// ---------------------------------------------------------------------------

const HOME = mkdtempSync(join(tmpdir(), 'nebius-auth-flows-'))
process.env.ALCHEMY_HOME = HOME

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
  delete process.env.ALCHEMY_HOME
})

/**
 * The persisted document for one (profile, store-key) pair. The key strings are the on-disk
 * contract — `nebius-stored` / `nebius-sa-key` / `nebius-oauth` — so asserting the file is
 * asserting what a later run (or the user) will read back.
 */
const STORED_KEY = 'nebius-stored'
const SA_KEY_KEY = 'nebius-sa-key'
const OAUTH_KEY = 'nebius-oauth'

const credentialFile = (profileName: string, key: string) =>
  AlchemyCredentials.credentialsFilePath(profileName, key)

const writeCredentialFixture = (profileName: string, key: string, value: unknown): void => {
  const path = credentialFile(profileName, key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

const readCredential = (profileName: string, key: string): unknown =>
  JSON.parse(readFileSync(credentialFile(profileName, key), 'utf8'))

const credentialFileExists = (profileName: string, key: string): boolean => {
  try {
    readFileSync(credentialFile(profileName, key))
    return true
  } catch {
    return false
  }
}

const newProfile = () => `flows-${randomUUID()}`

// ---------------------------------------------------------------------------
// Scripted Interaction
// ---------------------------------------------------------------------------

interface Script {
  readonly select?: Array<unknown>
  readonly password?: Array<string>
  readonly text?: Array<string>
  readonly confirm?: Array<boolean>
}

interface RecordedPrompt {
  readonly kind: string
  readonly message: string
  /** The values each `select` offered, so a test can pin the choices shown. */
  readonly optionValues?: ReadonlyArray<unknown>
  readonly initialValue?: unknown
}

const scriptedInteraction = (script: Script) => {
  const prompts: Array<RecordedPrompt> = []
  const notes: Array<{ kind: string; message: string }> = []

  const answer = <T>(
    kind: string,
    message: string,
    queue: Array<T> | undefined,
    extra?: object,
    validate?: (value: T) => string | undefined,
  ): Effect.Effect<T> => {
    prompts.push({ kind, message, ...extra })
    const next = queue?.shift()
    // A defect (not a typed failure): an unscripted prompt means the flow changed.
    if (next === undefined) return Effect.die(new Error(`unscripted ${kind} prompt: ${message}`))
    // The real terminal re-prompts until a prompt's own validator is happy, so an answer the
    // flow would reject (an empty API key) must not sail through here either.
    const issue = validate?.(next)
    return issue === undefined
      ? Effect.succeed(next)
      : Effect.die(new Error(`${kind} prompt rejected the answer: ${issue}`))
  }
  const note = (kind: string) => (message: string | { message: string }) =>
    Effect.sync(() => {
      notes.push({ kind, message: typeof message === 'string' ? message : message.message })
    })

  const service = {
    output: {
      info: note('info'),
      success: note('success'),
      warning: note('warning'),
      error: note('error'),
    },
    prompt: {
      select: (options: { message: string; options: ReadonlyArray<{ value: unknown }>; initialValue?: unknown }) =>
        answer('select', options.message, script.select, {
          optionValues: options.options.map((option) => option.value),
          initialValue: options.initialValue,
        }),
      password: (options: { message: string; validate?: (value: string) => string | undefined }) =>
        answer('password', options.message, script.password, undefined, options.validate),
      text: (options: { message: string; validate?: (value: string) => string | undefined }) =>
        answer('text', options.message, script.text, undefined, options.validate),
      confirm: (options: { message: string }) => answer('confirm', options.message, script.confirm),
      multiSelect: (options: { message: string }) => answer('multiSelect', options.message, undefined),
      awaitExternal: (options: { message: string }) => answer('awaitExternal', options.message, undefined),
    },
  }

  return {
    prompts,
    notes,
    layer: Layer.succeed(Interaction, service as never),
    /** Assert the prompts, in order, as `kind: message` pairs. */
    asked: () => prompts.map((prompt) => `${prompt.kind}: ${prompt.message}`),
  }
}

// ---------------------------------------------------------------------------
// Recording service fakes
// ---------------------------------------------------------------------------

const SETUP_SA_KEY = {
  serviceAccountId: 'serviceaccount-bootstrapped',
  keyId: 'publickey-bootstrapped',
  privateKey: '-----BEGIN PRIVATE KEY-----\nBOOTSTRAPPED\n-----END PRIVATE KEY-----',
}

/**
 * A fake `ChildProcessSpawner`, so the browser flow can never launch a real browser.
 *
 * `openUrl` spawns the platform opener (`open`, `xdg-open`) with the authorize URL. That matters
 * far beyond this file: **the mutation campaign explores mutants that route a test into the
 * browser OAuth flow**, and the first campaign over `AuthProvider.ts` opened dozens of real
 * browser windows pointing at the loopback callback server — which is closed by then, so every
 * window showed "connection refused". With the spawner faked, the spawn is recorded instead and
 * the safety is structural rather than a promise to behave.
 */
const noBrowserSpawner = () => {
  const spawned: Array<unknown> = []
  // Only `exitCode` is read by `openUrl` (0 = the browser opened); the stdio members are never
  // touched, so the service is a structural double and cast once below.
  const handle = { pid: 1, exitCode: Effect.succeed(0), isRunning: Effect.succeed(false), kill: () => Effect.void }
  return {
    spawned,
    layer: Layer.succeed(ChildProcessSpawner, {
      spawn: (command: unknown) =>
        Effect.sync(() => {
          spawned.push(command)
          return handle
        }),
    } as never),
  }
}

const makeFakes = (options: { mintFails?: boolean; projectDetailsFail?: boolean } = {}) => {
  const minted: Array<SaToken.SaKey> = []
  const bootstrapped: Array<string> = []
  return {
    minted,
    bootstrapped,
    saTokenMinter: Layer.succeed(SaToken.SaTokenMinter, {
      mint: (key: SaToken.SaKey) =>
        options.mintFails === true
          ? Effect.fail(new SaToken.SaTokenError({ message: 'mint rejected by the token service' }))
          : Effect.sync(() => {
              minted.push(key)
              return 'minted-test-token'
            }),
    }),
    saBootstrap: Layer.succeed(SaBootstrap.SaBootstrap, {
      bootstrap: (token: Redacted.Redacted<string>) =>
        Effect.sync(() => {
          bootstrapped.push(Redacted.value(token))
          return SETUP_SA_KEY
        }),
      getProjectDetails: () =>
        options.projectDetailsFail === true
          ? Effect.fail(new SaBootstrap.SaBootstrapError({ message: 'project lookup denied' }))
          : Effect.succeed({ name: 'Test Project', tenantId: 'tenant-from-bootstrap' }),
      deactivateKey: () => Effect.succeed(undefined),
    }),
  }
}

// ---------------------------------------------------------------------------
// Running a flow
// ---------------------------------------------------------------------------

const SA_KEY_ENV = {
  NEBIUS_SA_ID: 'serviceaccount-from-env',
  NEBIUS_SA_KEY_ID: 'publickey-from-env',
  NEBIUS_SA_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nENV\n-----END PRIVATE KEY-----',
}

interface RunOptions {
  readonly env?: Record<string, string>
  readonly script?: Script
  /** Make the token minter fail, for the error-mapping assertions. */
  readonly mintFails?: boolean
  /** Make the bootstrap's friendly project lookup fail, for its error mapping. */
  readonly projectDetailsFail?: boolean
}

/**
 * The flows' error channel as the contract declares it: `AuthError` for the interactive methods,
 * `NeedsReauth` for `details` (stale credentials), and `PlatformError` where the credential write
 * chmods a file and the contract does not narrow that. The assertions still check the `_tag` they
 * expect.
 */
type FlowError = AuthError | NeedsReauth | PlatformError

/**
 * The three contract methods this file drives, with the optionality the `AuthProviderImpl`
 * contract declares resolved up front — `runFlow` fails loudly if the provider does not implement
 * `configureWith` at all, instead of every test needing a null check.
 */
interface AuthFlows {
  readonly configure: (profile: string, current?: NebiusAuthConfig) => Effect.Effect<NebiusAuthConfig, FlowError, Interaction>
  readonly configureWith: (
    profile: string,
    input: { readonly method: string; readonly values: Record<string, string> },
  ) => Effect.Effect<NebiusAuthConfig, FlowError, Interaction>
  readonly login: (profile: string, config: NebiusAuthConfig) => Effect.Effect<void, FlowError, Interaction>
  readonly logout: (profile: string, config: NebiusAuthConfig) => Effect.Effect<void, FlowError, Interaction>
  readonly details: (profile: string, config: NebiusAuthConfig) => Effect.Effect<ProviderDetails, FlowError, Interaction>
  /** The CI contract: env only, no profile, no prompts (`R = never`). */
  readonly readEnvironment: Effect.Effect<NebiusResolvedCredentials, FlowError>
}

// `configureWith` is optional in the `AuthProviderImpl` contract, so the façade below checks it
// is implemented before calling it (loudly, rather than silently skipping the flow).

/**
 * Run `body` with a Nebius auth provider built over the temp home, the scripted interaction and
 * the recording fakes. The result is an `Effect.result`, so a caller can assert either arm.
 */
const runFlow = async <A>(
  { env = {}, script = {}, mintFails = false, projectDetailsFail = false }: RunOptions,
  body: (auth: AuthFlows) => Effect.Effect<A, FlowError, Interaction>,
) => {
  const interaction = scriptedInteraction(script)
  const fakes = makeFakes({ mintFails, projectDetailsFail })
  const browser = noBrowserSpawner()

  const layer = Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
    Layer.provide(AlchemyCredentials.CredentialsStoreLive.pipe(Layer.provide(PlatformNode.NodeServices.layer))),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        PlatformNode.NodeServices.layer,
        // Overrides NodeServices' real spawner, so nothing in these flows can open a browser.
        browser.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
        fakes.saTokenMinter,
        fakes.saBootstrap,
        interaction.layer,
      ),
    ),
  )

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* getAuthProvider<NebiusAuthConfig, NebiusResolvedCredentials>(
        NEBIUS_AUTH_PROVIDER_NAME,
      )
      // Arrow wrappers that *invoke* the methods (not bare references — the linter bans unbound
      // methods, and these closures never use `this` anyway).
      return yield* body({
        configure: (profile, current) => auth.configure(profile, current),
        configureWith: (profile, input) => {
          if (auth.configureWith === undefined) {
            return Effect.die(new Error('the Nebius auth provider does not implement configureWith'))
          }
          return auth.configureWith(profile, input)
        },
        login: (profile, config) => auth.login(profile, config),
        logout: (profile, config) => auth.logout(profile, config),
        details: (profile, config) => auth.details(profile, config),
        readEnvironment: auth.readEnvironment ?? Effect.die(new Error('no readEnvironment')),
      })
    }).pipe(Effect.provide(layer), Effect.result).pipe(Effect.orDie),
  )

  return { result, interaction, fakes, browser }
}

/** Run a flow expecting success, and return the outcome with its result unwrapped. */
const runOk = async <A>(
  options: RunOptions,
  body: (auth: AuthFlows) => Effect.Effect<A, FlowError, Interaction>,
): Promise<{
  result: A
  interaction: ReturnType<typeof scriptedInteraction>
  fakes: ReturnType<typeof makeFakes>
  browser: ReturnType<typeof noBrowserSpawner>
}> => {
  const { result, interaction, fakes, browser } = await runFlow(options, body)
  if (result._tag === 'Failure') {
    throw new Error(`expected success, got ${result.failure._tag}: ${result.failure.message}`)
  }
  return { result: result.success, interaction, fakes, browser }
}

/** Run a flow expecting an `AuthError`. */
const runFailing = async (
  options: RunOptions,
  body: (auth: AuthFlows) => Effect.Effect<unknown, FlowError, Interaction>,
): Promise<FlowError> => {
  const { result } = await runFlow(options, body)
  if (result._tag === 'Success') {
    throw new Error(`expected an AuthError, got ${JSON.stringify(result.success)}`)
  }
  return result.failure
}

// ---------------------------------------------------------------------------
// configureWith — the flag-driven path (`alchemy profile edit --set …`, agents)
// ---------------------------------------------------------------------------

describe('configureWith', () => {
  test('stored: persists the API key as a 0600 credential document', async () => {
    const profile = newProfile()
    const { result } = await runOk({}, (auth) =>
      auth.configureWith(profile, { method: 'stored', values: { apiKey: 'key-abc123' } }),
    )

    expect(result).toEqual({ method: 'stored' })
    const path = credentialFile(profile, STORED_KEY)
    expect(readCredential(profile, STORED_KEY)).toEqual({ type: 'apiKey', apiKey: 'key-abc123' })
    // The whole reason `writeSecureCredentials` exists: the store writes 0644 by default.
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('stored: a missing apiKey is rejected, and nothing is written', async () => {
    const profile = newProfile()
    const error = await runFailing({}, (auth) => auth.configureWith(profile, { method: 'stored', values: {} }))

    expect(error.message).toContain('Missing required --set apiKey=<value>')
    expect(credentialFileExists(profile, STORED_KEY)).toBe(false)
  })

  test('stored: an empty apiKey is rejected too', async () => {
    const profile = newProfile()
    const error = await runFailing({}, (auth) =>
      auth.configureWith(profile, { method: 'stored', values: { apiKey: '' } }),
    )

    expect(error.message).toContain('Missing required --set apiKey=<value>')
    expect(credentialFileExists(profile, STORED_KEY)).toBe(false)
  })

  test('env: selects the environment method without writing anything', async () => {
    const profile = newProfile()
    const { result, interaction } = await runOk({}, (auth) => auth.configureWith(profile, { method: 'env', values: {} }))

    expect(result).toEqual({ method: 'env' })
    expect(credentialFileExists(profile, STORED_KEY)).toBe(false)
    // The flag path must never prompt: it exists for scripts and agents.
    expect(interaction.asked()).toEqual([])
  })

  test('sa-key: validates the environment material by minting a token', async () => {
    const profile = newProfile()
    const { result, fakes } = await runOk({ env: SA_KEY_ENV }, (auth) =>
      auth.configureWith(profile, { method: 'sa-key', values: {} }),
    )

    expect(result).toEqual({ method: 'sa-key' })
    // Validation by minting is the point: it fails at configure time, not at the first API call.
    expect(fakes.minted).toHaveLength(1)
    expect(fakes.minted[0]).toMatchObject({
      serviceAccountId: 'serviceaccount-from-env',
      keyId: 'publickey-from-env',
    })
  })

  test('sa-key: without material it refuses, naming the env vars and the reconfigure hint', async () => {
    const profile = newProfile()
    const error = await runFailing({}, (auth) => auth.configureWith(profile, { method: 'sa-key', values: {} }))

    expect(error.message).toContain('service-account key credentials not found')
    expect(error.message).toContain('NEBIUS_SA_ID')
    expect(error.message).toContain('alchemy profile edit --profile')
  })

  test('an unknown method is rejected with the three valid ones', async () => {
    const profile = newProfile()
    const error = await runFailing({}, (auth) =>
      auth.configureWith(profile, { method: 'api-key', values: { apiKey: 'x' } }),
    )

    expect(error.message).toContain('unknown --method "api-key"')
    expect(error.message).toContain('stored, env, sa-key')
  })
})

// ---------------------------------------------------------------------------
// login — `alchemy profile refresh` and friends
// ---------------------------------------------------------------------------

describe('login', () => {
  test('env: is a no-op — nothing to renew, nothing to prompt', async () => {
    const profile = newProfile()
    const { interaction } = await runOk({}, (auth) => auth.login(profile, { method: 'env' }))

    expect(interaction.asked()).toEqual([])
    expect(interaction.notes).toEqual([])
  })

  test('stored: an existing API key is left alone', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, STORED_KEY, { type: 'apiKey', apiKey: 'existing-key' })

    const { interaction } = await runOk({}, (auth) => auth.login(profile, { method: 'stored' }))

    expect(interaction.asked()).toEqual([])
    expect(readCredential(profile, STORED_KEY)).toEqual({ type: 'apiKey', apiKey: 'existing-key' })
  })

  test('stored: with no credentials it prompts for the key and saves it', async () => {
    const profile = newProfile()
    const { interaction } = await runOk({ script: { password: ['pasted-key'] } }, (auth) =>
      auth.login(profile, { method: 'stored' }),
    )

    expect(interaction.asked()).toEqual(['password: Nebius API Key'])
    expect(interaction.notes).toContainEqual({ kind: 'success', message: 'Nebius: credentials saved.' })
    expect(readCredential(profile, STORED_KEY)).toEqual({ type: 'apiKey', apiKey: 'pasted-key' })
  })

  test('oauth: a still-valid token only reports success', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'token-still-valid',
      expiresAt: Date.now() + 60_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })

    const { interaction } = await runOk({}, (auth) => auth.login(profile, { method: 'oauth' }))

    expect(interaction.asked()).toEqual([])
    expect(interaction.notes).toContainEqual({ kind: 'success', message: 'Nebius: OAuth login valid.' })
  })

  test('sa-key: stored material is validated by minting, then reported', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, SA_KEY_KEY, {
      type: 'saKey',
      serviceAccountId: 'serviceaccount-stored',
      keyId: 'publickey-stored',
      privateKey: '-----BEGIN PRIVATE KEY-----\nSTORED\n-----END PRIVATE KEY-----',
      projectId: 'project-1',
    })

    const { fakes, interaction } = await runOk({}, (auth) => auth.login(profile, { method: 'sa-key' }))

    expect(fakes.minted).toHaveLength(1)
    expect(fakes.bootstrapped).toEqual([])
    expect(interaction.notes).toContainEqual({ kind: 'success', message: 'Nebius: service-account key available.' })
  })

  test('sa-key: without material it bootstraps from a pasted API key and stores the key', async () => {
    const profile = newProfile()
    const { interaction, fakes } = await runOk(
      {
        env: { NEBIUS_PROJECT_ID: 'project-1' },
        // The whole bootstrap conversation, in order: source, the pasted key, the SA name, the grant.
        script: { select: ['apiKey', 'editor'], password: ['one-time-bootstrap-key'], text: ['my-sa'] },
      },
      (auth) => auth.login(profile, { method: 'sa-key' }),
    )

    expect(interaction.asked()).toEqual([
      'select: Create the service account using',
      'password: Nebius API Key',
      'text: Service account name',
      'select: Grant the SA a role on project Test Project (project-1)?',
    ])
    // No OAuth login is stored here, so the only source offered is the pasted API key — the
    // "recommended" OAuth option appears only when a still-valid token exists (next test).
    expect(interaction.prompts[0]?.optionValues).toEqual(['apiKey'])
    // The bootstrap ends by printing the CI variable names, which is the whole point of storing a
    // key you can also paste into CI.
    expect(interaction.notes.map((n) => n.message)).toContain('  NEBIUS_SA_KEY_ID=publickey-bootstrapped')
    expect(fakes.bootstrapped).toEqual(['one-time-bootstrap-key'])
    expect(fakes.minted).toHaveLength(1)
    expect(interaction.notes).toContainEqual({ kind: 'success', message: 'Nebius: service-account key available.' })

    const stored = readCredential(profile, SA_KEY_KEY) as { keyId: string; serviceAccountId: string; type: string }
    expect(stored.type).toBe('saKey')
    expect(stored.keyId).toBe('publickey-bootstrapped')
    expect(stored.serviceAccountId).toBe('serviceaccount-bootstrapped')
    // The persisted document must decode against the exported schema — that is what a later
    // `read` does, and a hand-written fixture that drifts would fail there instead of here.
    expect(() => Schema.decodeUnknownSync(NebiusSaKeyCredentialsSchema)(stored)).not.toThrow()
  })

  test('a mint failure is wrapped as a `login failed` AuthError that keeps the cause', async () => {
    const profile = newProfile()
    const error = await runFailing({ env: SA_KEY_ENV, mintFails: true }, (auth) =>
      auth.login(profile, { method: 'sa-key' }),
    )

    // `login` wraps every arm's failure twice: the inner maps the mint error to its message, the
    // outer adds the `login failed` headline. Losing either level loses the diagnostic.
    expect(error._tag).toBe('AuthError')
    expect(error.message).toBe('login failed')
    expect((error.cause as { message?: string }).message).toBe('mint rejected by the token service')
  })
})

// ---------------------------------------------------------------------------
// configure — the interactive path (`alchemy profile create / edit`)
// ---------------------------------------------------------------------------

describe('configure', () => {
  test('env: selects without prompting for values, and pre-selects the stored method', async () => {
    const profile = newProfile()
    const { result, interaction } = await runOk({ script: { select: ['env'] } }, (auth) =>
      auth.configure(profile, { method: 'oauth' }),
    )

    expect(result).toEqual({ method: 'env' })
    expect(interaction.asked()).toEqual(['select: Nebius authentication method'])
    // The stored method rides along as the prompt's initial value (so re-running `edit` is a
    // single Enter), and the options are the four supported methods.
    expect(interaction.prompts[0]?.initialValue).toBe('oauth')
    expect(interaction.prompts[0]?.optionValues).toEqual(['oauth', 'sa-key', 'env', 'stored'])
  })

  test('stored: prompts for the key, writes it, and returns the method', async () => {
    const profile = newProfile()
    const { result, interaction } = await runOk({ script: { select: ['stored'], password: ['typed-key'] } }, (auth) =>
      auth.configure(profile, undefined),
    )

    expect(result).toEqual({ method: 'stored' })
    expect(interaction.asked()).toEqual(['select: Nebius authentication method', 'password: Nebius API Key'])
    expect(readCredential(profile, STORED_KEY)).toEqual({ type: 'apiKey', apiKey: 'typed-key' })
  })

  test('sa-key: with no material it bootstraps and stores the key', async () => {
    const profile = newProfile()
    const { result, fakes } = await runOk(
      {
        env: { NEBIUS_PROJECT_ID: 'project-1' },
        script: { select: ['sa-key', 'apiKey', 'editor'], password: ['bootstrap-key'], text: ['my-sa'] },
      },
      (auth) => auth.configure(profile, undefined),
    )

    expect(result).toEqual({ method: 'sa-key' })
    expect(fakes.bootstrapped).toEqual(['bootstrap-key'])
    // The stored document records the project it was bootstrapped for (and the tenant), which is
    // what makes the mismatch prompt above possible later.
    expect(readCredential(profile, SA_KEY_KEY)).toMatchObject({
      keyId: 'publickey-bootstrapped',
      projectId: 'project-1',
      tenantId: 'tenant-from-bootstrap',
    })
  })

  test('sa-key: stored material for another project offers keep/rebootstrap, and `keep` mints it', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, SA_KEY_KEY, {
      type: 'saKey',
      serviceAccountId: 'serviceaccount-stored',
      keyId: 'publickey-stored',
      privateKey: '-----BEGIN PRIVATE KEY-----\nSTORED\n-----END PRIVATE KEY-----',
      projectId: 'project-old',
    })

    const { result, fakes, interaction } = await runOk(
      { env: { NEBIUS_PROJECT_ID: 'project-new' }, script: { select: ['sa-key', 'keep'] } },
      (auth) => auth.configure(profile, undefined),
    )

    expect(result).toEqual({ method: 'sa-key' })
    // The project mismatch is surfaced *before* the user hits a confusing PermissionDenied.
    expect(interaction.asked()[1]).toBe(
      'select: The stored service-account key is for project project-old, but NEBIUS_PROJECT_ID is project-new.',
    )
    expect(fakes.bootstrapped).toEqual([])
    expect(fakes.minted).toHaveLength(1)
    expect(fakes.minted[0]).toMatchObject({ serviceAccountId: 'serviceaccount-stored' })
  })

  test('sa-key: `rebootstrap` on the same mismatch runs the bootstrap instead', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, SA_KEY_KEY, {
      type: 'saKey',
      serviceAccountId: 'serviceaccount-stored',
      keyId: 'publickey-stored',
      privateKey: '-----BEGIN PRIVATE KEY-----\nSTORED\n-----END PRIVATE KEY-----',
      projectId: 'project-old',
    })

    const { result, fakes, interaction } = await runOk(
      {
        env: { NEBIUS_PROJECT_ID: 'project-new' },
        script: {
          select: ['sa-key', 'rebootstrap', 'apiKey', 'editor'],
          password: ['fresh-key'],
          text: ['my-sa'],
        },
      },
      (auth) => auth.configure(profile, undefined),
    )

    expect(result).toEqual({ method: 'sa-key' })
    expect(fakes.bootstrapped).toEqual(['fresh-key'])
    expect(interaction.asked()[1]).toContain('but NEBIUS_PROJECT_ID is project-new')
    // …and the new material replaces the old document.
    expect(readCredential(profile, SA_KEY_KEY)).toMatchObject({
      keyId: 'publickey-bootstrapped',
      projectId: 'project-new',
    })
  })
})

// ---------------------------------------------------------------------------
// Bootstrap branches, `details`, `logout`, and the CI path
// ---------------------------------------------------------------------------

describe('bootstrap branches', () => {
  test('without NEBIUS_PROJECT_ID it refuses before prompting at all', async () => {
    const profile = newProfile()
    const { result, interaction } = await runFlow({ script: { select: ['sa-key'] } }, (auth) =>
      auth.configure(profile, undefined),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      // The sa-key arm wraps the cause, so the actionable text is nested inside its headline.
      expect(result.failure.message).toContain(
        'Nebius service-account key not usable: Set NEBIUS_PROJECT_ID to bootstrap a service account.',
      )
    }
    // The check runs *before* the second prompt, so the user is not walked through choices that
    // cannot work (and nothing is written).
    expect(interaction.asked()).toEqual(['select: Nebius authentication method'])
    expect(credentialFileExists(profile, SA_KEY_KEY)).toBe(false)
  })

  test('a stored OAuth token is offered as the bootstrap credential source', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'stored-access-token',
      expiresAt: Date.now() + 60_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })

    const { interaction, fakes } = await runOk(
      {
        env: { NEBIUS_PROJECT_ID: 'project-1' },
        script: { select: ['oauth', 'editor'], text: ['my-sa'] },
      },
      (auth) => auth.login(profile, { method: 'sa-key' }),
    )

    // The bootstrap-source select offers OAuth *first* when a valid token is stored, so the
    // recommended path is one Enter away — and the chosen source is the stored access token.
    expect(interaction.prompts[0]?.message).toBe('Create the service account using')
    expect(interaction.prompts[0]?.optionValues).toEqual(['oauth', 'apiKey'])
    expect(fakes.bootstrapped).toEqual(['stored-access-token'])
  })

  test('an unreadable NEBIUS_SA_PRIVATE_KEY_FILE names the path and the cause', async () => {
    const profile = newProfile()
    const error = await runFailing(
      { env: { ...SA_KEY_ENV, NEBIUS_SA_PRIVATE_KEY: '', NEBIUS_SA_PRIVATE_KEY_FILE: '/nonexistent/key.pem' } },
      (auth) => auth.configureWith(profile, { method: 'sa-key', values: {} }),
    )

    expect(error.message).toContain('Could not read private key file /nonexistent/key.pem')
    // ENOENT vs EACCES need different fixes, so the cause must survive into the message.
    expect(error.message).toContain('ENOENT')
  })

  test('a mint failure while configuring sa-key is wrapped as "not usable"', async () => {
    const profile = newProfile()
    const error = await runFailing({ env: SA_KEY_ENV, mintFails: true, script: { select: ['sa-key'] } }, (auth) =>
      auth.configure(profile, { method: 'sa-key' }),
    )

    expect(error.message).toContain('Nebius service-account key not usable')
    expect(error.message).toContain('mint rejected by the token service')
  })
})

describe('details (`alchemy profile show`)', () => {
  test('reports the env API key redacted, with its source', async () => {
    const profile = newProfile()
    const { result } = await runOk({ env: { NEBIUS_API_KEY: 'key-abcdefghijkl' } }, (auth) =>
      auth.details(profile, { method: 'env' }),
    )

    const lines = Object.fromEntries(result.lines.map((line) => [line.key, line.value]))
    // Redacted to a 7-character prefix plus `****` — the whole point of `displayRedacted`, so
    // `profile show` never prints a usable key.
    expect(lines.apiKey).toBe('key-abc****')
    expect(lines.source).toBe('env')
  })

  test('a key shorter than the visible prefix is fully hidden', async () => {
    const profile = newProfile()
    const { result } = await runOk({ env: { NEBIUS_API_KEY: 'short' } }, (auth) =>
      auth.details(profile, { method: 'env' }),
    )

    const lines = Object.fromEntries(result.lines.map((line) => [line.key, line.value]))
    expect(lines.apiKey).toBe('****')
  })

  test('names the service account when the source carries a detail', async () => {
    const profile = newProfile()
    const { result } = await runOk({ env: SA_KEY_ENV }, (auth) => auth.details(profile, { method: 'sa-key' }))

    const lines = Object.fromEntries(result.lines.map((line) => [line.key, line.value]))
    expect(lines.source).toBe('sa-key - serviceaccount-from-env')
  })
})

describe('logout', () => {
  test('oauth: removes the stored token document', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'token',
      expiresAt: Date.now() + 60_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })

    const { interaction } = await runOk({}, (auth) => auth.logout(profile, { method: 'oauth' }))

    expect(credentialFileExists(profile, OAUTH_KEY)).toBe(false)
    expect(interaction.notes).toContainEqual({ kind: 'success', message: 'Nebius: OAuth credentials removed.' })
  })

  test('stored: removes the API key document', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, STORED_KEY, { type: 'apiKey', apiKey: 'key' })

    const { interaction } = await runOk({}, (auth) => auth.logout(profile, { method: 'stored' }))

    expect(credentialFileExists(profile, STORED_KEY)).toBe(false)
    expect(interaction.notes).toContainEqual({ kind: 'success', message: 'Nebius: stored credentials removed' })
  })
})

describe('readEnvironment (the CI path)', () => {
  test('a static API key is used directly', async () => {
    const { result } = await runOk({ env: { NEBIUS_API_KEY: 'ci-key' } }, (auth) => auth.readEnvironment)

    expect(Redacted.value(result.apiKey)).toBe('ci-key')
    expect(result.source).toEqual({ type: 'env' })
  })

  test('the service-account group mints a token, naming the SA in the source', async () => {
    const { result, fakes } = await runOk({ env: SA_KEY_ENV }, (auth) => auth.readEnvironment)

    expect(Redacted.value(result.apiKey)).toBe('minted-test-token')
    expect(result.source).toEqual({ type: 'sa-key', details: 'serviceaccount-from-env' })
    expect(fakes.minted).toHaveLength(1)
  })

  test('an incomplete group is named in the failure, with nothing to resolve', async () => {
    const error = await runFailing({ env: { NEBIUS_SA_ID: 'serviceaccount-only' } }, (auth) => auth.readEnvironment)

    expect(error.message).toContain('Nebius CI credentials not found')
    expect(error.message).toContain('The service-account group is incomplete')
    expect(error.message).toContain('NEBIUS_SA_ID')
  })

  test('with nothing set it explains both CI options', async () => {
    const error = await runFailing({}, (auth) => auth.readEnvironment)

    expect(error.message).toContain('Set NEBIUS_API_KEY, or NEBIUS_SA_ID + NEBIUS_SA_KEY_ID')
    // No half-set group to name here.
    expect(error.message).not.toContain('incomplete')
  })
})

describe('bootstrap error mapping and file input', () => {
  test('an empty answer to a prompt is rejected by the prompt validator', async () => {
    const profile = newProfile()

    // The scripted interaction runs the flow's own `validate` and dies on a rejected answer (a
    // defect, since the real terminal would simply re-prompt), so an empty API key must throw
    // rather than be persisted. Captured by hand: bun's `expect(...).rejects` is not seen as a
    // thenable by the linter.
    const outcome = await runFlow({ script: { password: [''] } }, (auth) =>
      auth.login(profile, { method: 'stored' }),
    ).then(
      () => 'resolved',
      (error: unknown) => String(error),
    )

    expect(outcome).toContain('password prompt rejected the answer: Required')
    expect(credentialFileExists(profile, STORED_KEY)).toBe(false)
  })

  test('a failing project lookup is wrapped as an AuthError naming the cause', async () => {
    const profile = newProfile()
    const error = await runFailing(
      {
        env: { NEBIUS_PROJECT_ID: 'project-1' },
        projectDetailsFail: true,
        script: { select: ['apiKey', 'editor'], password: ['key'], text: ['my-sa'] },
      },
      (auth) => auth.login(profile, { method: 'sa-key' }),
    )

    expect(error.message).toContain('login failed')
    expect((error.cause as { message?: string }).message).toBe('project lookup denied')
  })

  test('the private key file is read as text, and reaches the minter unchanged', async () => {
    const profile = newProfile()
    const pem = '-----BEGIN PRIVATE KEY-----\nFROM-FILE\n-----END PRIVATE KEY-----\n'
    const keyFile = join(HOME, 'sa-key.pem')
    writeFileSync(keyFile, pem)

    const { fakes } = await runOk(
      { env: { ...SA_KEY_ENV, NEBIUS_SA_PRIVATE_KEY: '', NEBIUS_SA_PRIVATE_KEY_FILE: keyFile } },
      (auth) => auth.configureWith(profile, { method: 'sa-key', values: {} }),
    )

    // Encoding matters: read as a Buffer the PEM would reach the JWT signer as bytes, and the
    // trailing newline must survive too.
    expect(typeof fakes.minted[0]?.privateKey).toBe('string')
    expect(fakes.minted[0]?.privateKey).toBe(pem)
  })
})

// ---------------------------------------------------------------------------
// The browser arm — reached, but never actually opened
// ---------------------------------------------------------------------------

describe('the OAuth browser arm', () => {
  test('a valid stored token skips the browser entirely', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'token-still-valid',
      expiresAt: Date.now() + 60_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })

    const { browser } = await runOk({}, (auth) => auth.login(profile, { method: 'oauth' }))

    expect(browser.spawned).toEqual([])
  })

  test('an expired token reaches the browser step, and the spawn is intercepted', async () => {
    const profile = newProfile()
    writeCredentialFixture(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'token-expired',
      expiresAt: Date.now() - 1_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })

    // The flow races the loopback callback against a paste prompt; answering the prompt with a
    // callback URL whose `state` does not match is the fastest way to drive it end to end without
    // a browser (the PKCE check rejects it, so `login` fails — which is the assertion below).
    const { browser, interaction, result } = await runFlow(
      { script: { text: ['http://127.0.0.1:1/callback?code=abc&state=not-the-state'] } },
      (auth) => auth.login(profile, { method: 'oauth' }),
    )

    // Exactly one spawn: the authorize URL, via the faked spawner — no real browser process.
    expect(browser.spawned).toHaveLength(1)
    // And the URL the user would open is narrated, so a headless run can still complete by hand.
    const notes = interaction.notes.map((note) => note.message)
    expect(notes.some((note) => note.includes('opening browser for OAuth login'))).toBe(true)
    expect(notes.some((note) => note.startsWith('https://'))).toBe(true)

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure.message).toBe('login failed')
  })
})
