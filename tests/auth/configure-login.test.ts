/**
 * `configureWith` / `configure` / `login` — the three provider methods behind alchemy's
 * `profile` commands (`create`, `edit --reconfigure`, `refresh`, `delete`), i.e. everything a
 * user does to set up or renew Nebius credentials.
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
import { AuthError, AuthProviders, getAuthProvider } from 'alchemy/Auth/AuthProvider'
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

  const answer = <T>(kind: string, message: string, queue: Array<T> | undefined, extra?: object): Effect.Effect<T> => {
    prompts.push({ kind, message, ...extra })
    const next = queue?.shift()
    // A defect (not a typed failure): an unscripted prompt means the flow changed.
    return next === undefined
      ? Effect.die(new Error(`unscripted ${kind} prompt: ${message}`))
      : Effect.succeed(next)
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
      password: (options: { message: string }) => answer('password', options.message, script.password),
      text: (options: { message: string }) => answer('text', options.message, script.text),
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

const makeFakes = (options: { mintFails?: boolean } = {}) => {
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
      getProjectDetails: () => Effect.succeed({ name: 'Test Project', tenantId: 'tenant-from-bootstrap' }),
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
}

/**
 * `configure`/`configureWith` admit `PlatformError` as well as `AuthError` (the credential write
 * chmods the file and the provider contract does not narrow that), so the flows' error channel is
 * the union. The assertions still check the `_tag` they expect.
 */
type FlowError = AuthError | PlatformError

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
}

/** `configureWith` is optional in the contract; the flows below require it. */
const required = <T>(method: T | undefined, name: string): T => {
  if (method === undefined) throw new Error(`the Nebius auth provider does not implement ${name}`)
  return method
}

/**
 * Run `body` with a Nebius auth provider built over the temp home, the scripted interaction and
 * the recording fakes. The result is an `Effect.result`, so a caller can assert either arm.
 */
const runFlow = async <A>(
  { env = {}, script = {}, mintFails = false }: RunOptions,
  body: (auth: AuthFlows) => Effect.Effect<A, FlowError, Interaction>,
) => {
  const interaction = scriptedInteraction(script)
  const fakes = makeFakes({ mintFails })

  const layer = Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
    Layer.provide(AlchemyCredentials.CredentialsStoreLive.pipe(Layer.provide(PlatformNode.NodeServices.layer))),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        PlatformNode.NodeServices.layer,
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
      // Arrow wrappers, not bare method references: the linter bans unbound methods, and these
      // closures never use `this` anyway.
      const configureWith = required(auth.configureWith, 'configureWith')
      return yield* body({
        configure: (profile, current) => auth.configure(profile, current),
        configureWith: (profile, input) => configureWith(profile, input),
        login: (profile, config) => auth.login(profile, config),
      })
    }).pipe(Effect.provide(layer), Effect.result).pipe(Effect.orDie),
  )

  return { result, interaction, fakes }
}

/** Run a flow expecting success, and return the outcome with its result unwrapped. */
const runOk = async <A>(
  options: RunOptions,
  body: (auth: AuthFlows) => Effect.Effect<A, FlowError, Interaction>,
): Promise<{ result: A; interaction: ReturnType<typeof scriptedInteraction>; fakes: ReturnType<typeof makeFakes> }> => {
  const { result, interaction, fakes } = await runFlow(options, body)
  if (result._tag === 'Failure') {
    throw new Error(`expected success, got ${result.failure._tag}: ${result.failure.message}`)
  }
  return { result: result.success, interaction, fakes }
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
