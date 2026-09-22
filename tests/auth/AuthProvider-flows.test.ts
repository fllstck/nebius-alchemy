/**
 * `AuthProvider` **flows and their doubles** — the arms that were unreachable, not merely
 * unasserted.
 *
 * The mutation report over `modules/AuthProvider.ts` (2026-09-22) showed 58 `NoCoverage` mutants
 * clustered in exactly the paths that talk to the outside: the OAuth login's tenant/project
 * pickers, the interactive bootstrap, and every `Effect.mapError` arm that needs a *failing*
 * dependency. This file closes them with doubles:
 *
 *   * `SaBootstrap` — a fake service returning scripted tenants/projects and recording the
 *     bootstrap call. (This is why `listTenants`/`listProjects` moved onto the service: reached by
 *     `import`, they had no double at all, so no unit test could enter the flow.)
 *   * the OAuth token endpoint — `stubTokenEndpoint` (a `fetch` seam; the URL is a module constant).
 *   * `Interaction` — the scripted prompt/note recorder, so the *questions* are assertable.
 *   * `ChildProcessSpawner` — so `openUrl` can never launch a browser (the mutation-campaign lesson).
 *
 * `tests/AuthProvider.test.ts` keeps the resolution/redaction contract; this file drives the flows.
 */
import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import type { PlatformError } from 'effect/PlatformError'
import { Interaction } from 'alchemy/Interaction'
import * as Redacted from 'effect/Redacted'
import { AuthProviders, AuthError, getAuthProvider, NeedsReauth } from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'
import {
  NebiusAuth,
  NEBIUS_AUTH_PROVIDER_NAME,
  type NebiusAuthConfig,
  type NebiusResolvedCredentials,
} from '../../modules/AuthProvider.ts'
import * as OAuth from '../../modules/auth/oauth.ts'
import * as SaBootstrap from '../../modules/auth/sa-bootstrap.ts'
import * as SaToken from '../../modules/auth/sa-token.ts'
import { noBrowserSpawner, scriptedInteraction, type Script } from '../helpers/interaction.ts'
import { stubTokenEndpoint } from '../helpers/oauth-token-double.ts'

// ---------------------------------------------------------------------------
// Isolated home (the credential store is a real file under $ALCHEMY_HOME)
// ---------------------------------------------------------------------------

const HOME = mkdtempSync(join(tmpdir(), 'nebius-auth-flows-'))
process.env.ALCHEMY_HOME = HOME

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
  delete process.env.ALCHEMY_HOME
})

const OAUTH_KEY = 'nebius-oauth'
const SA_KEY_KEY = 'nebius-sa-key'

const credentialPath = (profile: string, key: string) => AlchemyCredentials.credentialsFilePath(profile, key)
const readCredential = (profile: string, key: string) =>
  JSON.parse(readFileSync(credentialPath(profile, key), 'utf8')) as Record<string, unknown>
const writeCredential = (profile: string, key: string, value: unknown) => {
  const path = credentialPath(profile, key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

const newProfile = () => `authflow-${randomUUID()}`

/**
 * `login` funnels every failure through `new AuthError({ message: 'login failed', cause: e })`, so
 * the *specific* message an operator reads lives in `cause` — assert that, and assert the wrapper
 * once so the shape itself is pinned.
 */
const failureCause = (failure: unknown): AuthError => (failure as { cause: AuthError }).cause

const SA_KEY = {
  serviceAccountId: 'serviceaccount-bootstrapped',
  keyId: 'publickey-bootstrapped',
  privateKey: '-----BEGIN PRIVATE KEY-----\nBOOTSTRAPPED\n-----END PRIVATE KEY-----',
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly env?: Record<string, string>
  readonly script?: Script
  readonly mintFails?: boolean
  readonly tenants?: ReadonlyArray<{ id: string; name: string }> | 'fail'
  readonly projects?: ReadonlyArray<{ id: string; name: string }> | 'fail'
  readonly bootstrapFails?: boolean
  readonly projectDetails?: { name?: string; tenantId?: string } | 'fail'
  readonly deactivateFails?: boolean
  readonly browserExitCode?: number
}

/** Everything a test wants to assert *after* the flow, plus the layers the flow needs. */
const harness = (options: HarnessOptions = {}) => {
  const interaction = scriptedInteraction(options.script ?? {})
  const browser = noBrowserSpawner({ exitCode: options.browserExitCode })
  const minted: Array<SaToken.SaKey> = []
  const bootstrapped: Array<{ token: string; options: SaBootstrap.BootstrapOptions }> = []
  const deactivated: Array<{ token: string; keyId: string }> = []
  const lists: Array<string> = []

  const tenants = options.tenants ?? [{ id: 'tenant-1', name: 'Tenant One' }]
  const projects = options.projects ?? [{ id: 'project-1', name: 'Project One' }]

  const saBootstrap = Layer.succeed(SaBootstrap.SaBootstrap, {
    bootstrap: (token, bootstrapOptions) =>
      options.bootstrapFails === true
        ? Effect.fail(new SaBootstrap.SaBootstrapError({ message: 'bootstrap denied by IAM' }))
        : Effect.sync(() => {
            bootstrapped.push({ token: Redacted.value(token), options: bootstrapOptions })
            return SA_KEY
          }),
    getProjectDetails: () =>
      options.projectDetails === 'fail'
        ? Effect.fail(new SaBootstrap.SaBootstrapError({ message: 'project lookup denied' }))
        : Effect.succeed(options.projectDetails ?? { name: 'Test Project', tenantId: 'tenant-from-bootstrap' }),
    deactivateKey: (token, keyId) =>
      options.deactivateFails === true
        ? Effect.fail(new SaBootstrap.SaBootstrapError({ message: 'deactivation denied' }))
        : Effect.sync(() => {
            deactivated.push({ token: Redacted.value(token), keyId })
          }),
    listTenants: () =>
      Effect.sync(() => lists.push('tenants')).pipe(
        Effect.flatMap(() =>
          tenants === 'fail'
            ? Effect.fail<SaBootstrap.SaBootstrapError>(new SaBootstrap.SaBootstrapError({ message: 'tenant list denied' }))
            : Effect.succeed(tenants),
        ),
      ),
    listProjects: (_token, tenantId) =>
      Effect.sync(() => lists.push(`projects:${tenantId}`)).pipe(
        Effect.flatMap(() =>
          projects === 'fail'
            ? Effect.fail<SaBootstrap.SaBootstrapError>(
                new SaBootstrap.SaBootstrapError({ message: 'project list denied' }),
              )
            : Effect.succeed(projects),
        ),
      ),
  })

  const layer = Layer.mergeAll(AlchemyProfile.ProfileStoreLive, NebiusAuth).pipe(
    Layer.provide(AlchemyCredentials.CredentialsStoreLive.pipe(Layer.provide(PlatformNode.NodeServices.layer))),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        PlatformNode.NodeServices.layer,
        browser.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown(options.env ?? {})),
        Layer.succeed(SaToken.SaTokenMinter, {
          mint: (key: SaToken.SaKey) =>
            options.mintFails === true
              ? Effect.fail(new SaToken.SaTokenError({ message: 'mint rejected by the token service' }))
              : Effect.sync(() => {
                  minted.push(key)
                  return 'minted-test-token'
                }),
        }),
        saBootstrap,
        interaction.layer,
      ),
    ),
  )

  return { interaction, browser, minted, bootstrapped, deactivated, lists, layer }
}

/**
 * Run `body` against the provider built over the harness, returning the `Result` so a test can
 * assert either arm. `tokenEndpoint` optionally stubs the OAuth token exchange.
 */
const runAuth = async <A>(
  options: HarnessOptions,
  body: (
    auth: Effect.Success<ReturnType<typeof provider>>,
    h: ReturnType<typeof harness>,
  ) => Effect.Effect<A, AuthError | NeedsReauth | PlatformError, Interaction>,
  tokenEndpoint?: (request: { url: string; body: URLSearchParams }) => Response,
) => {
  const h = harness(options)
  const double = tokenEndpoint === undefined ? undefined : stubTokenEndpoint(tokenEndpoint)
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        return yield* body(yield* provider(), h)
      }).pipe(Effect.provide(h.layer), Effect.result),
    )
  } finally {
    double?.restore()
  }
}

/** The provider façade: the contract methods, with the optionality resolved once. */
const providerBridge = () =>
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<NebiusAuthConfig, NebiusResolvedCredentials>(NEBIUS_AUTH_PROVIDER_NAME)
  return {
    configure: (profile: string, current?: NebiusAuthConfig) => auth.configure(profile, current),
    configureWith: (profile: string, input: { method: string; values: Record<string, string> }) =>
      auth.configureWith === undefined
        ? Effect.die(new Error('configureWith is not implemented'))
        : auth.configureWith(profile, input),
    login: (profile: string, config: NebiusAuthConfig) => auth.login(profile, config),
    logout: (profile: string, config: NebiusAuthConfig) => auth.logout(profile, config),
      read: (profile: string, config: NebiusAuthConfig) => auth.read(profile, config),
      // The CI contract: env only, no profile, no prompts (R = never). Its arm is `current` or
      // `never` — `readEnvironment` is optional on the contract, so the façade fails loudly.
      readEnvironment: auth.readEnvironment ?? Effect.die(new Error('readEnvironment is not implemented')),
    }
  })

const provider = providerBridge

const doubles: Array<{ restore: () => void }> = []
afterEach(() => {
  for (const d of doubles.splice(0)) d.restore()
})

// ---------------------------------------------------------------------------
// The OAuth login flow (no coverage at all before this file)
// ---------------------------------------------------------------------------

const OAUTH_ENV = {} // no NEBIUS_* needed: the tenant comes from the token

describe('AuthProvider.loginOAuth (through the real flow, with doubles)', () => {
  test('a pasted callback URL completes the login: prompts, stored document, narration', async () => {
    const profile = newProfile()
    const { h, result } = await runWith(
      {
        env: OAUTH_ENV,
        // The documented headless path: paste the callback URL. Its `state` is generated by the flow
        // a moment earlier, so the answer is computed from the authorize URL the flow narrated.
        script: {
          text: [
            ({ notes }) => {
              const authorize = notes.find((note) => note.message.startsWith(OAuth.OAUTH_AUTHORIZE_ENDPOINT))
              const state = new URL(authorize!.message).searchParams.get('state')
              return `http://127.0.0.1:1/callback?code=the-code&state=${state}`
            },
          ],
          select: ['tenant-1', 'project-1'],
        },
        tenants: [
          { id: 'tenant-1', name: 'Tenant One' },
          { id: 'tenant-2', name: '' },
        ],
        projects: [{ id: 'project-1', name: 'Project One' }],
      },
      (auth) => auth.login(profile, { method: 'oauth' }),
      (request) => {
        expect(request.body.get('code')).toBe('the-code')
        return Response.json({ access_token: 'oauth-token-abc', expires_in: 43_200 })
      },
    )

    expect(result._tag).toBe('Success')

    // --- the stored document (the on-disk contract a later run reads back)
    const stored = readCredential(profile, OAUTH_KEY)
    expect(stored.type).toBe('oauth')
    expect(stored.accessToken).toBe('oauth-token-abc')
    expect(stored.projectId).toBe('project-1')
    expect(stored.tenantId).toBe('tenant-1')
    const expiresAt = stored.expiresAt as number
    expect(expiresAt).toBeGreaterThan(Date.now() + 43_000_000)

    // --- what the user was told, in order
    const notes = h.interaction.notes.map((note) => note.message)
    expect(notes.some((note) => note.includes('authenticating with OAuth client nebius-cli'))).toBe(true)
    expect(notes.some((note) => note.includes('opening browser for OAuth login'))).toBe(true)
    expect(notes.some((note) => note.includes('waiting for authorization (up to 5 minutes)'))).toBe(true)
    expect(notes.some((note) => note.startsWith('https://auth.nebius.com/oauth2/authorize'))).toBe(true)
    expect(notes).toContain('Nebius: logged in. Project: project-1')

    // --- the prompts: the paste prompt, then the tenant picker (2 tenants) and the project picker
    expect(h.interaction.asked()).toEqual([
      'text: Paste the authorization code or callback URL',
      'select: Select the tenant',
      'select: Select the project',
    ])
    const tenantPrompt = h.interaction.prompts[1]!
    expect(tenantPrompt.options).toEqual([
      { value: 'tenant-1', label: 'Tenant One', description: 'tenant-1' },
      // An unnamed tenant falls back to its id as the label, with no description.
      { value: 'tenant-2', label: 'tenant-2', description: undefined },
    ])
    const projectPrompt = h.interaction.prompts[2]!
    expect(projectPrompt.options).toEqual([
      { value: 'project-1', label: 'Project One', description: 'project-1' },
    ])

    // --- the paste prompt's hint (the only place the flow explains the headless fallback)
    expect(h.interaction.prompts[0]!.placeholder).toBe('The browser will complete this automatically when local')

    // --- the browser was "opened" exactly once, through the fake spawner
    expect(h.browser.spawned).toHaveLength(1)
  })

  test('a single tenant skips the tenant picker entirely', async () => {
    const profile = newProfile()
    const { h, result } = await runWith(
      {
        script: { text: ['bare-code'], select: ['project-1'] },
        tenants: [{ id: 'tenant-only', name: 'Only Tenant' }],
        projects: [{ id: 'project-1', name: 'Project One' }],
      },
      (auth) => auth.login(profile, { method: 'oauth' }),
      () => Response.json({ access_token: 't', expires_in: 60 }),
    )

    expect(result._tag).toBe('Success')
    expect(h.interaction.asked()).toEqual([
      'text: Paste the authorization code or callback URL',
      'select: Select the project',
    ])
    expect(readCredential(profile, OAUTH_KEY).tenantId).toBe('tenant-only')
    // The project list is scoped to the tenant the token resolved to.
    expect(h.lists).toEqual(['tenants', 'projects:tenant-only'])
  })

  test('a bare code (no pasted URL, so no state to validate) is accepted', async () => {
    const profile = newProfile()
    const result = await runAuth(
      { script: { text: ['  bare-code  '], select: ['project-1'] } },
      (auth) => auth.login(profile, { method: 'oauth' }),
      (request) => {
        expect(request.body.get('code')).toBe('bare-code')
        return Response.json({ access_token: 't', expires_in: 60 })
      },
    )
    expect(result._tag).toBe('Success')
  })

  test('no tenants is an actionable error, not an empty picker', async () => {
    const profile = newProfile()
    const { result } = await runWith(
      { script: { text: ['bare-code'] }, tenants: [] },
      (auth) => auth.login(profile, { method: 'oauth' }),
      () => Response.json({ access_token: 't', expires_in: 60 }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect((result.failure as AuthError).message).toBe('login failed')
      expect(failureCause(result.failure).message).toBe('No tenants found for the logged-in user.')
    }
  })

  test('no projects is an actionable error too', async () => {
    const profile = newProfile()
    const { result } = await runWith(
      { script: { text: ['bare-code'] }, projects: [] },
      (auth) => auth.login(profile, { method: 'oauth' }),
      () => Response.json({ access_token: 't', expires_in: 60 }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(failureCause(result.failure).message).toBe('No projects found for the logged-in user.')
  })

  test('a failing tenant listing surfaces the service message (the mapError arm)', async () => {
    const profile = newProfile()
    const { result } = await runWith(
      { script: { text: ['bare-code'] }, tenants: 'fail' },
      (auth) => auth.login(profile, { method: 'oauth' }),
      () => Response.json({ access_token: 't', expires_in: 60 }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(failureCause(result.failure).message).toBe('tenant list denied')
  })

  test('a failing project listing surfaces the service message', async () => {
    const profile = newProfile()
    const { result } = await runWith(
      { script: { text: ['bare-code'] }, projects: 'fail' },
      (auth) => auth.login(profile, { method: 'oauth' }),
      () => Response.json({ access_token: 't', expires_in: 60 }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(failureCause(result.failure).message).toBe('project list denied')
  })

  test('a rejected token exchange is reported inside the login context', async () => {
    const profile = newProfile()
    const result = await runAuth(
      { script: { text: ['bare-code'] } },
      (auth) => auth.login(profile, { method: 'oauth' }),
      () => new Response('invalid_grant', { status: 400 }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const message = failureCause(result.failure).message
      expect(message).toContain('Nebius OAuth login failed:')
      expect(message).toContain('token endpoint returned 400')
      expect(message).toContain('invalid_grant')
    }
  })

  test('an empty paste is rejected by the prompt itself, before any exchange', async () => {
    const profile = newProfile()
    // The scripted interaction enforces the flow's own validator, exactly as the terminal
    // re-prompts — and raises a defect for a rejected answer, so the failure must not be silent.
    const thrown = await runAuth(
      { script: { text: ['   '] } },
      (auth) => auth.login(profile, { method: 'oauth' }),
    ).then(
      () => undefined,
      (error: unknown) => String(error),
    )
    expect(thrown).toContain('text prompt rejected the answer: Paste a code or URL')
    // Nothing was exchanged: a rejected answer must not reach the token endpoint.
    expect(() => readCredential(profile, OAUTH_KEY)).toThrow()
  })

  test('a browser that cannot open warns instead of failing the login', async () => {
    const profile = newProfile()
    const { h, result } = await runWith(
      { script: { text: ['bare-code'], select: ['project-1'] }, browserExitCode: 1 },
      (auth) => auth.login(profile, { method: 'oauth' }),
      () => Response.json({ access_token: 't', expires_in: 60 }),
    )

    expect(result._tag).toBe('Success')
    const notes = h.interaction.notes
    expect(
      notes.some(
        (note) =>
          note.kind === 'warning' &&
          note.message === 'Nebius: could not open browser automatically. Please open the URL above manually.',
      ),
    ).toBe(true)
  })

  test('the callback arm: the loopback browser hit completes the login without any paste', async () => {
    const profile = newProfile()
    const h = harness({
      // The paste prompt is started by the race but never answers (`hangText`), so the ONLY way the
      // flow can complete is the loopback callback — the browser path, end to end.
      script: { hangText: true, select: ['project-1'] },
    })
    const double = stubTokenEndpoint(() => Response.json({ access_token: 'callback-token', expires_in: 60 }))
    try {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* provider()
          const fiber = yield* Effect.forkChild(auth.login(profile, { method: 'oauth' }))
          // Wait for the authorize URL to be narrated (the server is listening by then), then act
          // as the browser would: hit the callback with the state the flow generated.
          const authorizeUrl = Effect.gen(function* () {
            for (let attempt = 0; attempt < 200; attempt++) {
              const authorize = h.interaction.notes.find((note) =>
                note.message.startsWith(OAuth.OAUTH_AUTHORIZE_ENDPOINT),
              )
              if (authorize !== undefined) return authorize.message
              // An Effect sleep, not a synchronous spin: the login runs in a fiber, and a blocking
              // loop would starve it (the runtime is single-threaded per fiber).
              yield* Effect.sleep(10)
            }
            return undefined
          })
          const authorize = yield* authorizeUrl
          expect(authorize).toBeDefined()
          const state = new URL(authorize!).searchParams.get('state')
          const redirectUri = new URL(authorize!).searchParams.get('redirect_uri')!
          yield* Effect.promise(() =>
            fetch(`${redirectUri}/?code=callback-code&state=${state}`, { redirect: 'manual' }).then(() => undefined),
          )
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(h.layer), Effect.result),
      )

      expect(outcome._tag).toBe('Success')
      expect(readCredential(profile, OAUTH_KEY).accessToken).toBe('callback-token')
      // The paste prompt WAS asked (the race starts both arms) — it simply never won.
      expect(h.interaction.asked()[0]).toBe('text: Paste the authorization code or callback URL')
    } finally {
      double.restore()
    }
  })
})

/** Like `runAuth`, but returns the harness so tests can assert prompts/notes/spawns. */
const runWith = async <A>(
  options: HarnessOptions,
  body: (
    auth: Effect.Success<ReturnType<typeof provider>>,
  ) => Effect.Effect<A, AuthError | NeedsReauth | PlatformError, Interaction>,
  tokenEndpoint?: (request: { url: string; body: URLSearchParams }) => Response,
) => {
  const h = harness(options)
  const double = tokenEndpoint === undefined ? undefined : stubTokenEndpoint(tokenEndpoint)
  doubles.push({ restore: () => double?.restore() })
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* body(yield* provider())
      }).pipe(Effect.provide(h.layer), Effect.result),
    )
    return { h, result }
  } finally {
    // The stub stays installed until `afterEach`, because the assertion inside `tokenEndpoint`
    // (the request body) may run after this promise resolves only in the callback arm; for the
    // synchronous arms it is already satisfied.
    if (tokenEndpoint === undefined) double?.restore()
  }
}


// ---------------------------------------------------------------------------
// The interactive `configure` picker and the bootstrap it can trigger
// ---------------------------------------------------------------------------

describe('AuthProvider.configure (method picker)', () => {
  test('offers every method with the labels and descriptions the user reads', async () => {
    const profile = newProfile()
    const { h, result } = await runWith({ script: { select: ['env'] } }, (auth) =>
      auth.configure(profile, undefined),
    )

    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success).toEqual({ method: 'env' })
    const methodPrompt = h.interaction.prompts[0]!
    expect(methodPrompt.message).toBe('Nebius authentication method')
    expect(methodPrompt.initialValue).toBeUndefined()
    expect(methodPrompt.options).toEqual([
      {
        value: 'oauth',
        label: 'Nebius account (OAuth)',
        description: 'browser-based login — no CLI, no service account',
      },
      {
        value: 'sa-key',
        label: 'Service Account Key',
        description: 'non-interactive RFC 8693 exchange — set NEBIUS_SA_ID + NEBIUS_SA_KEY_ID + private key',
      },
      { value: 'env', label: 'Environment Variable', description: 'NEBIUS_API_KEY' },
      { value: 'stored', label: 'API Key', description: 'enter interactively, stored in ~/.alchemy/credentials' },
    ])
  })

  test('pre-selects the currently stored method', async () => {
    const { h } = await runWith({ script: { select: ['env'] } }, (auth) =>
      auth.configure(newProfile(), { method: 'sa-key' }),
    )
    expect(h.interaction.prompts[0]!.initialValue).toBe('sa-key')
  })

  test('the API-key arm stores what was typed and says so', async () => {
    const profile = newProfile()
    const { h, result } = await runWith({ script: { select: ['stored'], password: ['api-key-123'] } }, (auth) =>
      auth.configure(profile, undefined),
    )

    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success).toEqual({ method: 'stored' })
    expect(h.interaction.asked()).toEqual(['select: Nebius authentication method', 'password: Nebius API Key'])
    expect(readCredential(profile, 'nebius-stored')).toEqual({ type: 'apiKey', apiKey: 'api-key-123' })
    expect(h.interaction.notes.map((note) => note.message)).toContain('Nebius: credentials saved.')
  })

  test('the sa-key arm with material in the environment validates it by minting (no bootstrap)', async () => {
    const { h, result } = await runWith(
      {
        env: { NEBIUS_SA_ID: 'sa-env', NEBIUS_SA_KEY_ID: 'key-env', NEBIUS_SA_PRIVATE_KEY: 'PEM' },
        script: { select: ['sa-key'] },
      },
      (auth) => auth.configure(newProfile(), undefined),
    )

    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success).toEqual({ method: 'sa-key' })
    // Only the method picker was asked: existing material means no name/role/grant prompts.
    expect(h.interaction.asked()).toEqual(['select: Nebius authentication method'])
    expect(h.minted).toEqual([{ serviceAccountId: 'sa-env', keyId: 'key-env', privateKey: 'PEM' }])
  })

  test('a broken sa-key arm reports it inside the sa-key context', async () => {
    const { result } = await runWith(
      {
        env: { NEBIUS_SA_ID: 'sa-env', NEBIUS_SA_KEY_ID: 'key-env', NEBIUS_SA_PRIVATE_KEY: 'PEM' },
        script: { select: ['sa-key'] },
        mintFails: true,
      },
      (auth) => auth.configure(newProfile(), undefined),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect((result.failure as AuthError).message).toContain('Nebius service-account key not usable:')
      expect((result.failure as AuthError).message).toContain('mint rejected by the token service')
    }
  })

  test('a completing oauth configure reports the oauth method', async () => {
    const profile = newProfile()
    const { result } = await runWith(
      {
        script: { select: ['oauth', 'project-1'], text: ['bare-code'] },
        tenants: [{ id: 'tenant-1', name: 'Tenant One' }],
        projects: [{ id: 'project-1', name: 'Project One' }],
      },
      (auth) => auth.configure(profile, undefined),
      () => Response.json({ access_token: 't', expires_in: 60 }),
    )
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success).toEqual({ method: 'oauth' })
  })

  test('a broken oauth arm reports the flow error inside the OAuth context', async () => {
    const profile = newProfile()
    const { result } = await runWith(
      { script: { select: ['oauth'], text: ['bare-code'] } },
      (auth) => auth.configure(profile, undefined),
      () => new Response('invalid_client', { status: 401 }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const message = (result.failure as AuthError).message
      expect(message).toContain('Nebius OAuth not usable:')
      expect(message).toContain('token endpoint returned 401')
    }
  })
})

describe('AuthProvider.bootstrapSaKey (the interactive bootstrap)', () => {
  const bootstrapEnv = { NEBIUS_PROJECT_ID: 'project-env' }

  test('the bootstrap prompts, the bootstrap args, the stored document and the CI instructions', async () => {
    const profile = newProfile()
    const { h, result } = await runWith(
      {
        env: bootstrapEnv,
        script: {
          select: ['sa-key', 'apiKey', 'editor'],
          text: ['the-sa-name'],
          password: ['bootstrap-api-key'],
        },
      },
      (auth) => auth.configure(profile, undefined),
    )

    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') expect(result.success).toEqual({ method: 'sa-key' })

    // --- the prompts, in order, with the choices the user saw
    expect(h.interaction.asked()).toEqual([
      'select: Nebius authentication method',
      'select: Create the service account using',
      'password: Nebius API Key',
      'text: Service account name',
      'select: Grant the SA a role on project Test Project (project-env)?',
    ])
    expect(h.interaction.prompts[1]!.options).toEqual([
      { value: 'apiKey', label: 'API key', description: 'paste a Nebius API key (one time)' },
    ])
    expect(h.interaction.prompts[3]!.initialValue).toBe('nebius-alchemy-sa')
    expect(h.interaction.prompts[4]!.options).toEqual([
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
    ])

    // --- the bootstrap call the flow made
    expect(h.bootstrapped).toEqual([
      {
        token: 'bootstrap-api-key',
        options: {
          parentId: 'project-env',
          serviceAccountName: 'the-sa-name',
          grant: { role: 'editor', resourceId: 'project-env' },
        },
      },
    ])

    // --- the stored document (the tenant comes from the project lookup)
    expect(readCredential(profile, 'nebius-sa-key')).toEqual({
      type: 'saKey',
      ...SA_KEY,
      projectId: 'project-env',
      tenantId: 'tenant-from-bootstrap',
    })

    // --- what the user is told, including the copy-paste CI block
    const notes = h.interaction.notes.map((note) => note.message)
    expect(notes).toContain('No Nebius service-account key found — bootstrapping one now.')
    expect(notes).toContain('Nebius: service-account key created and stored.')
    expect(notes).toContain('To use in CI, set:')
    expect(notes).toContain('  NEBIUS_SA_ID=serviceaccount-bootstrapped')
    expect(notes).toContain('  NEBIUS_SA_KEY_ID=publickey-bootstrapped')
    expect(notes).toContain('  NEBIUS_SA_PRIVATE_KEY=<private key PEM>')
  })

  test('the admin grant is passed through verbatim', async () => {
    const { h } = await runWith(
      {
        env: bootstrapEnv,
        script: { select: ['sa-key', 'apiKey', 'admin'], text: ['sa-name'], password: ['k'] },
      },
      (auth) => auth.configure(newProfile(), undefined),
    )
    expect(h.bootstrapped[0]!.options.grant).toEqual({ role: 'admin', resourceId: 'project-env' })
  })

  test('a project lookup without a name labels the prompt with the raw project id', async () => {
    const { h } = await runWith(
      {
        env: bootstrapEnv,
        projectDetails: { tenantId: 'tenant-x' },
        script: { select: ['sa-key', 'apiKey', 'editor'], text: ['sa-name'], password: ['k'] },
      },
      (auth) => auth.configure(newProfile(), undefined),
    )
    expect(h.interaction.asked()[4]).toBe('select: Grant the SA a role on project project-env?')
  })

  test('a valid stored OAuth token is offered as the bootstrap credential — and used as the token', async () => {
    const profile = newProfile()
    writeCredential(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'stored-oauth-token',
      expiresAt: Date.now() + 60_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })

    const { h } = await runWith(
      {
        env: bootstrapEnv,
        script: { select: ['sa-key', 'oauth', 'editor'], text: ['sa-name'] },
      },
      (auth) => auth.configure(profile, undefined),
    )

    // Both sources are offered while the token is valid…
    expect(h.interaction.prompts[1]!.optionValues).toEqual(['oauth', 'apiKey'])
    expect(h.interaction.prompts[1]!.options![0]).toEqual({
      value: 'oauth',
      label: 'Nebius OAuth login',
      description: 'use the current browser login (recommended)',
    })
    // …and choosing OAuth uses the stored access token as the one-time bootstrap credential.
    expect(h.bootstrapped[0]!.token).toBe('stored-oauth-token')
  })

  test('an EXPIRED stored OAuth token is not offered', async () => {
    const profile = newProfile()
    writeCredential(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'stale',
      expiresAt: Date.now() - 1_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })

    const { h } = await runWith(
      {
        env: bootstrapEnv,
        script: { select: ['sa-key', 'apiKey', 'editor'], text: ['sa-name'], password: ['k'] },
      },
      (auth) => auth.configure(profile, undefined),
    )
    expect(h.interaction.prompts[1]!.optionValues).toEqual(['apiKey'])
  })

  test('an empty API key answer is rejected by the prompt itself', async () => {
    const thrown = await runWith(
      { env: bootstrapEnv, script: { select: ['sa-key', 'apiKey'], password: [''] } },
      (auth) => auth.configure(newProfile(), undefined),
    ).then(
      (value) => value,
      (error: unknown) => error,
    )
    expect(String(thrown)).toContain('password prompt rejected the answer: Required')
  })

  test('bootstrap without NEBIUS_PROJECT_ID names the missing variable', async () => {
    const { result } = await runWith({ script: { select: ['sa-key'] } }, (auth) =>
      auth.configure(newProfile(), undefined),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect((result.failure as AuthError).message).toContain('Set NEBIUS_PROJECT_ID to bootstrap a service account.')
  })

  test('a failing project lookup surfaces the service message', async () => {
    const { result } = await runWith(
      {
        env: bootstrapEnv,
        projectDetails: 'fail',
        script: { select: ['sa-key', 'apiKey'], password: ['k'] },
      },
      (auth) => auth.configure(newProfile(), undefined),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect((result.failure as AuthError).message).toContain('project lookup denied')
  })

  test('a failing bootstrap surfaces the service message', async () => {
    const { result } = await runWith(
      {
        env: bootstrapEnv,
        bootstrapFails: true,
        script: { select: ['sa-key', 'apiKey', 'editor'], text: ['sa-name'], password: ['k'] },
      },
      (auth) => auth.configure(newProfile(), undefined),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect((result.failure as AuthError).message).toContain('bootstrap denied by IAM')
  })

  test('a stored key for a DIFFERENT project offers keep-or-rebootstrap, with both labels', async () => {
    const profile = newProfile()
    writeCredential(profile, SA_KEY_KEY, {
      type: 'saKey',
      ...SA_KEY,
      projectId: 'project-old',
      tenantId: 'tenant-1',
    })

    const { h, result } = await runWith(
      { env: { NEBIUS_PROJECT_ID: 'project-new' }, script: { select: ['sa-key', 'keep'] } },
      (auth) => auth.configure(profile, undefined),
    )

    expect(result._tag).toBe('Success')
    const mismatchPrompt = h.interaction.prompts[1]!
    expect(mismatchPrompt.message).toBe(
      'The stored service-account key is for project project-old, but NEBIUS_PROJECT_ID is project-new.',
    )
    expect(mismatchPrompt.options).toEqual([
      {
        value: 'keep',
        label: 'Use the existing key',
        description: 'the SA must already have access to the new project',
      },
      {
        value: 'rebootstrap',
        label: 'Create a new key for this project',
        description: 'bootstraps a new SA + key + grant',
      },
    ])
    // "keep" mints the stored key and does NOT bootstrap.
    expect(h.minted).toHaveLength(1)
    expect(h.bootstrapped).toEqual([])
  })

  test('rebootstrap creates a new key for the new project instead', async () => {
    const profile = newProfile()
    writeCredential(profile, SA_KEY_KEY, {
      type: 'saKey',
      ...SA_KEY,
      projectId: 'project-old',
      tenantId: 'tenant-1',
    })

    const { h } = await runWith(
      {
        env: { NEBIUS_PROJECT_ID: 'project-new' },
        script: {
          select: ['sa-key', 'rebootstrap', 'apiKey', 'editor'],
          text: ['sa-name'],
          password: ['k'],
        },
      },
      (auth) => auth.configure(profile, undefined),
    )
    expect(h.bootstrapped).toHaveLength(1)
    expect(h.bootstrapped[0]!.options.parentId).toBe('project-new')
  })
})

// ---------------------------------------------------------------------------
// The SA-key environment matrix
// ---------------------------------------------------------------------------

describe('AuthProvider sa-key resolution', () => {
  const keyFile = join(HOME, 'sa-key.pem')

  test('the inline private key is used as-is', async () => {
    const { h } = await runWith(
      {
        env: {
          NEBIUS_SA_ID: 'sa-1',
          NEBIUS_SA_KEY_ID: 'key-1',
          NEBIUS_SA_PRIVATE_KEY: 'INLINE-PEM',
        },
      },
      (auth) => auth.read(newProfile(), { method: 'sa-key' }),
    )
    expect(h.minted).toEqual([{ serviceAccountId: 'sa-1', keyId: 'key-1', privateKey: 'INLINE-PEM' }])
  })

  test('NEBIUS_SA_PRIVATE_KEY_FILE is read from disk, and wins over an inline key', async () => {
    writeFileSync(keyFile, 'FILE-PEM')
    const { h } = await runWith(
      {
        env: {
          NEBIUS_SA_ID: 'sa-1',
          NEBIUS_SA_KEY_ID: 'key-1',
          NEBIUS_SA_PRIVATE_KEY: 'INLINE-PEM',
          NEBIUS_SA_PRIVATE_KEY_FILE: keyFile,
        },
      },
      (auth) => auth.read(newProfile(), { method: 'sa-key' }),
    )
    expect(h.minted[0]!.privateKey).toBe('FILE-PEM')
  })

  test('an unreadable key file names the path and the cause', async () => {
    const missing = join(HOME, 'does-not-exist.pem')
    const { result } = await runWith(
      { env: { NEBIUS_SA_ID: 'sa-1', NEBIUS_SA_KEY_ID: 'key-1', NEBIUS_SA_PRIVATE_KEY_FILE: missing } },
      (auth) => auth.read(newProfile(), { method: 'sa-key' }),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const message = (result.failure as AuthError).message
      expect(message).toContain(`Could not read private key file ${missing}`)
      expect(message).toContain('ENOENT')
    }
  })

  test('a half-set group falls through to the stored key, then the not-found message', async () => {
    // Only the SA id: `readSaKeyEnv` must treat the group as absent (not as a key with holes).
    const { result } = await runWith({ env: { NEBIUS_SA_ID: 'sa-1' } }, (auth) =>
      auth.read(newProfile(), { method: 'sa-key' }),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const message = (result.failure as AuthError).message
      expect(message).toContain('Nebius service-account key credentials not found.')
      expect(message).toContain('Set NEBIUS_SA_ID / NEBIUS_SA_KEY_ID / NEBIUS_SA_PRIVATE_KEY for CI.')
    }
  })

  test('env material wins over the stored key', async () => {
    const profile = newProfile()
    writeCredential(profile, SA_KEY_KEY, { type: 'saKey', ...SA_KEY, projectId: 'project-1' })
    const { h } = await runWith(
      { env: { NEBIUS_SA_ID: 'sa-env', NEBIUS_SA_KEY_ID: 'key-env', NEBIUS_SA_PRIVATE_KEY: 'ENV-PEM' } },
      (auth) => auth.read(profile, { method: 'sa-key' }),
    )
    expect(h.minted).toEqual([{ serviceAccountId: 'sa-env', keyId: 'key-env', privateKey: 'ENV-PEM' }])
  })

  test('the stored key is used when the environment is empty', async () => {
    const profile = newProfile()
    writeCredential(profile, SA_KEY_KEY, { type: 'saKey', ...SA_KEY, projectId: 'project-1' })
    const { h } = await runWith({}, (auth) => auth.read(profile, { method: 'sa-key' }))
    expect(h.minted).toEqual([
      { serviceAccountId: SA_KEY.serviceAccountId, keyId: SA_KEY.keyId, privateKey: SA_KEY.privateKey },
    ])
  })

  test('a mint failure is reported with the service message', async () => {
    const { result } = await runWith(
      { env: { NEBIUS_SA_ID: 'sa-1', NEBIUS_SA_KEY_ID: 'key-1', NEBIUS_SA_PRIVATE_KEY: 'PEM' }, mintFails: true },
      (auth) => auth.read(newProfile(), { method: 'sa-key' }),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect((result.failure as AuthError).message).toContain('mint rejected by the token service')
  })
})

// ---------------------------------------------------------------------------
// Resolution: the OAuth/stored/env arms, login and logout
// ---------------------------------------------------------------------------

describe('AuthProvider.read (per-method resolved credentials)', () => {
  test('a valid OAuth token resolves to an apiKey with the oauth source (and the project as details)', async () => {
    const profile = newProfile()
    writeCredential(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'token-1',
      expiresAt: Date.now() + 60_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })
    const result = await runAuth({}, (auth) => auth.read(profile, { method: 'oauth' }))
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') {
      expect(Redacted.value(result.success.apiKey)).toBe('token-1')
      expect(result.success.source).toEqual({ type: 'oauth', details: 'project-1' })
    }
  })

  test('a missing OAuth document needs a re-login', async () => {
    const result = await runAuth({}, (auth) => auth.read(newProfile(), { method: 'oauth' }))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('NeedsReauth')
      expect((result.failure as NeedsReauth).message).toContain('Nebius OAuth credentials not found.')
    }
  })

  test('an OAuth token expiring exactly NOW is already expired (the boundary)', async () => {
    const profile = newProfile()
    const now = new Date('2026-03-01T00:00:00.000Z')
    setSystemTime(now)
    try {
      writeCredential(profile, OAUTH_KEY, {
        type: 'oauth',
        accessToken: 'token-1',
        expiresAt: now.getTime(),
        tenantId: 'tenant-1',
        projectId: 'project-1',
      })
      const result = await runAuth({}, (auth) => auth.read(profile, { method: 'oauth' }))
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('NeedsReauth')
        expect((result.failure as NeedsReauth).message).toContain('Nebius OAuth token expired.')
      }
    } finally {
      setSystemTime()
    }
  })

  test('stored credentials resolve with the stored source', async () => {
    const profile = newProfile()
    writeCredential(profile, 'nebius-stored', { type: 'apiKey', apiKey: 'stored-api-key' })
    const result = await runAuth({}, (auth) => auth.read(profile, { method: 'stored' }))
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') {
      expect(Redacted.value(result.success.apiKey)).toBe('stored-api-key')
      expect(result.success.source).toEqual({ type: 'stored' })
    }
  })

  test('missing stored credentials need a re-login', async () => {
    const result = await runAuth({}, (auth) => auth.read(newProfile(), { method: 'stored' }))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('NeedsReauth')
      expect((result.failure as NeedsReauth).message).toContain('Nebius stored credentials not found.')
    }
  })

  test('the env method resolves NEBIUS_API_KEY with the env source', async () => {
    const result = await runAuth({ env: { NEBIUS_API_KEY: 'env-api-key' } }, (auth) =>
      auth.read(newProfile(), { method: 'env' }),
    )
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') {
      expect(Redacted.value(result.success.apiKey)).toBe('env-api-key')
      expect(result.success.source).toEqual({ type: 'env' })
    }
  })

  test('the env method without a key says exactly what to set', async () => {
    const result = await runAuth({}, (auth) => auth.read(newProfile(), { method: 'env' }))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect((result.failure as AuthError).message).toBe('Nebius env credentials not found. Set NEBIUS_API_KEY.')
  })
})

describe('AuthProvider.login (per-method)', () => {
  test('a valid stored OAuth token is announced and no browser is opened', async () => {
    const profile = newProfile()
    writeCredential(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'token-1',
      expiresAt: Date.now() + 60_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })
    const { h, result } = await runWith({}, (auth) => auth.login(profile, { method: 'oauth' }))

    expect(result._tag).toBe('Success')
    expect(h.interaction.notes.map((note) => note.message)).toContain('Nebius: OAuth login valid.')
    expect(h.browser.spawned).toEqual([])
    expect(h.interaction.asked()).toEqual([])
  })

  test('an existing stored API key is not re-prompted for', async () => {
    const profile = newProfile()
    writeCredential(profile, 'nebius-stored', { type: 'apiKey', apiKey: 'k' })
    const { h, result } = await runWith({}, (auth) => auth.login(profile, { method: 'stored' }))
    expect(result._tag).toBe('Success')
    expect(h.interaction.asked()).toEqual([])
  })

  test('a missing stored API key prompts for one and saves it', async () => {
    const profile = newProfile()
    const { h, result } = await runWith({ script: { password: ['typed-key'] } }, (auth) =>
      auth.login(profile, { method: 'stored' }),
    )
    expect(result._tag).toBe('Success')
    expect(h.interaction.asked()).toEqual(['password: Nebius API Key'])
    expect(readCredential(profile, 'nebius-stored')).toEqual({ type: 'apiKey', apiKey: 'typed-key' })
  })

  test('an existing sa-key mints a token and announces availability', async () => {
    const profile = newProfile()
    writeCredential(profile, SA_KEY_KEY, { type: 'saKey', ...SA_KEY, projectId: 'project-1' })
    const { h, result } = await runWith({}, (auth) => auth.login(profile, { method: 'sa-key' }))

    expect(result._tag).toBe('Success')
    expect(h.minted).toHaveLength(1)
    expect(h.bootstrapped).toEqual([])
    expect(h.interaction.notes.map((note) => note.message)).toContain('Nebius: service-account key available.')
  })

  test('the env method has nothing to log in to', async () => {
    const { h, result } = await runWith({}, (auth) => auth.login(newProfile(), { method: 'env' }))
    expect(result._tag).toBe('Success')
    expect(h.interaction.asked()).toEqual([])
    expect(h.interaction.notes).toEqual([])
  })
})

describe('AuthProvider.logout (per-method)', () => {
  test('sa-key logout deactivates the key server-side and then removes the local material', async () => {
    const profile = newProfile()
    writeCredential(profile, SA_KEY_KEY, { type: 'saKey', ...SA_KEY, projectId: 'project-1' })
    const { h, result } = await runWith({}, (auth) => auth.logout(profile, { method: 'sa-key' }))

    expect(result._tag).toBe('Success')
    expect(h.minted).toHaveLength(1)
    expect(h.deactivated).toEqual([{ token: 'minted-test-token', keyId: SA_KEY.keyId }])
    const notes = h.interaction.notes.map((note) => note.message)
    expect(notes).toContain(`Nebius: authorized key ${SA_KEY.keyId} deactivated on the server.`)
    expect(notes).toContain('Nebius: SA-key credentials removed.')
    expect(() => readCredential(profile, SA_KEY_KEY)).toThrow()
  })

  test('a failed deactivation only warns, and still removes the local material', async () => {
    const profile = newProfile()
    writeCredential(profile, SA_KEY_KEY, { type: 'saKey', ...SA_KEY, projectId: 'project-1' })
    const { h, result } = await runWith({ deactivateFails: true }, (auth) =>
      auth.logout(profile, { method: 'sa-key' }),
    )

    expect(result._tag).toBe('Success')
    const warnings = h.interaction.notes.filter((note) => note.kind === 'warning').map((note) => note.message)
    expect(warnings).toEqual([
      `Nebius: could not deactivate authorized key ${SA_KEY.keyId} on the server (deactivation denied). Removing local credentials only.`,
    ])
    expect(() => readCredential(profile, SA_KEY_KEY)).toThrow()
  })

  test('sa-key logout with nothing stored just clears (no mint, no deactivation)', async () => {
    const { h, result } = await runWith({}, (auth) => auth.logout(newProfile(), { method: 'sa-key' }))
    expect(result._tag).toBe('Success')
    expect(h.minted).toEqual([])
    expect(h.deactivated).toEqual([])
    expect(h.interaction.notes.map((note) => note.message)).toContain('Nebius: SA-key credentials removed.')
  })

  test('oauth logout removes the token and says so', async () => {
    const profile = newProfile()
    writeCredential(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 't',
      expiresAt: Date.now() + 1_000,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })
    const { h, result } = await runWith({}, (auth) => auth.logout(profile, { method: 'oauth' }))
    expect(result._tag).toBe('Success')
    expect(h.interaction.notes.map((note) => note.message)).toContain('Nebius: OAuth credentials removed.')
    expect(() => readCredential(profile, OAUTH_KEY)).toThrow()
  })
})

describe('AuthProvider.readEnvironment (the CI contract)', () => {
  test('NEBIUS_API_KEY wins outright', async () => {
    const result = await runAuth(
      {
        env: {
          NEBIUS_API_KEY: 'ci-api-key',
          NEBIUS_SA_ID: 'sa-1',
          NEBIUS_SA_KEY_ID: 'key-1',
          NEBIUS_SA_PRIVATE_KEY: 'PEM',
        },
      },
      (auth) => auth.readEnvironment,
    )
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') {
      expect(Redacted.value(result.success.apiKey)).toBe('ci-api-key')
      expect(result.success.source).toEqual({ type: 'env' })
    }
  })

  test('a full SA-key group mints a token and names the SA', async () => {
    const { h, result } = await runWith(
      { env: { NEBIUS_SA_ID: 'sa-1', NEBIUS_SA_KEY_ID: 'key-1', NEBIUS_SA_PRIVATE_KEY: 'PEM' } },
      (auth) => auth.readEnvironment,
    )
    expect(result._tag).toBe('Success')
    if (result._tag === 'Success') {
      expect(Redacted.value(result.success.apiKey)).toBe('minted-test-token')
      expect(result.success.source).toEqual({ type: 'sa-key', details: 'sa-1' })
    }
    expect(h.minted).toEqual([{ serviceAccountId: 'sa-1', keyId: 'key-1', privateKey: 'PEM' }])
  })

  test('nothing usable names both options', async () => {
    const result = await runAuth({}, (auth) => auth.readEnvironment)
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const message = (result.failure as AuthError).message
      expect(message).toContain('Nebius CI credentials not found. Set NEBIUS_API_KEY, or')
      // Nothing partial was set, so no incomplete-group hint.
      expect(message).not.toContain('incomplete')
    }
  })

  test('a half-set service-account group lists what IS set and what is required', async () => {
    const result = await runAuth({ env: { NEBIUS_SA_ID: 'sa-1', NEBIUS_SA_KEY_ID: 'key-1' } }, (auth) =>
      auth.readEnvironment,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const message = (result.failure as AuthError).message
      expect(message).toContain('The service-account group is incomplete — set: NEBIUS_SA_ID, NEBIUS_SA_KEY_ID; required:')
      expect(message).toContain('NEBIUS_SA_PRIVATE_KEY or NEBIUS_SA_PRIVATE_KEY_FILE')
    }
  })
})

// ---------------------------------------------------------------------------
// The remaining calibrations: the env truth table, expiry boundaries and the
// arms that only a *different* answer can discriminate
// ---------------------------------------------------------------------------

describe('AuthProvider readSaKeyEnv truth table (every way a group can be incomplete)', () => {
  const notFound = 'Nebius service-account key credentials not found.'

  const expectNotFound = async (env: Record<string, string>) => {
    const { result } = await runWith({ env }, (auth) => auth.read(newProfile(), { method: 'sa-key' }))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect((result.failure as AuthError).message).toContain(notFound)
  }

  test('key id + private key but no service-account id is an incomplete group', async () => {
    await expectNotFound({ NEBIUS_SA_KEY_ID: 'k', NEBIUS_SA_PRIVATE_KEY: 'PEM' })
  })

  test('service-account id + private key but no key id is an incomplete group', async () => {
    await expectNotFound({ NEBIUS_SA_ID: 'sa', NEBIUS_SA_PRIVATE_KEY: 'PEM' })
  })

  test('id + key id but neither private key nor file is an incomplete group', async () => {
    await expectNotFound({ NEBIUS_SA_ID: 'sa', NEBIUS_SA_KEY_ID: 'k' })
  })

  test('a private key FILE without an id is an incomplete group', async () => {
    await expectNotFound({ NEBIUS_SA_PRIVATE_KEY_FILE: join(HOME, 'whatever.pem') })
  })

  test('the complete group (id + key id + file) resolves', async () => {
    const file = join(HOME, 'ok.pem')
    writeFileSync(file, 'FILE-PEM')
    const { h, result } = await runWith(
      { env: { NEBIUS_SA_ID: 'sa', NEBIUS_SA_KEY_ID: 'k', NEBIUS_SA_PRIVATE_KEY_FILE: file } },
      (auth) => auth.read(newProfile(), { method: 'sa-key' }),
    )
    expect(result._tag).toBe('Success')
    expect(h.minted[0]!.privateKey).toBe('FILE-PEM')
  })
})

describe('AuthProvider expiry boundaries (a token expiring NOW is expired)', () => {
  const at = new Date('2026-04-01T12:00:00.000Z')

  const withFrozenClock = async <A>(body: () => Promise<A>): Promise<A> => {
    setSystemTime(at)
    try {
      return await body()
    } finally {
      setSystemTime()
    }
  }

  test('the bootstrap does NOT offer a stored OAuth source that expires exactly now', async () => {
    const profile = newProfile()
    writeCredential(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'expiring',
      expiresAt: at.getTime(),
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })
    await withFrozenClock(async () => {
      const { h } = await runWith(
        {
          env: { NEBIUS_PROJECT_ID: 'project-env' },
          script: { select: ['sa-key', 'apiKey', 'editor'], text: ['sa-name'], password: ['k'] },
        },
        (auth) => auth.configure(profile, undefined),
      )
      expect(h.interaction.prompts[1]!.optionValues).toEqual(['apiKey'])
    })
  })

  test('login with a token expiring exactly now re-runs the browser flow', async () => {
    const profile = newProfile()
    writeCredential(profile, OAUTH_KEY, {
      type: 'oauth',
      accessToken: 'expiring',
      expiresAt: at.getTime(),
      tenantId: 'tenant-1',
      projectId: 'project-1',
    })
    await withFrozenClock(async () => {
      const { h, result } = await runWith(
        { script: { text: ['bare-code'], select: ['project-1'] } },
        (auth) => auth.login(profile, { method: 'oauth' }),
        () => Response.json({ access_token: 'fresh', expires_in: 60 }),
      )
      expect(result._tag).toBe('Success')
      // The flow ran: the authorize URL was narrated and the browser was "opened".
      expect(h.interaction.notes.some((note) => note.message.startsWith(OAuth.OAUTH_AUTHORIZE_ENDPOINT))).toBe(true)
      expect(h.browser.spawned).toHaveLength(1)
      expect(readCredential(profile, OAUTH_KEY).accessToken).toBe('fresh')
    })
  })
})

describe('AuthProvider sa-key re-bootstrap prompts (only when they can matter)', () => {
  const storedForOld = (profile: string) =>
    writeCredential(profile, SA_KEY_KEY, { type: 'saKey', ...SA_KEY, projectId: 'project-old', tenantId: 'tenant-1' })

  test('env material suppresses the keep-or-rebootstrap prompt entirely', async () => {
    const profile = newProfile()
    storedForOld(profile)
    const { h } = await runWith(
      {
        env: {
          NEBIUS_PROJECT_ID: 'project-new',
          NEBIUS_SA_ID: 'sa-env',
          NEBIUS_SA_KEY_ID: 'key-env',
          NEBIUS_SA_PRIVATE_KEY: 'ENV-PEM',
        },
        script: { select: ['sa-key'] },
      },
      (auth) => auth.configure(profile, undefined),
    )
    // No project-mismatch prompt: env material is deliberately project-agnostic.
    expect(h.interaction.asked()).toEqual(['select: Nebius authentication method'])
  })

  test('a stored key for the SAME project is used without prompting', async () => {
    const profile = newProfile()
    writeCredential(profile, SA_KEY_KEY, { type: 'saKey', ...SA_KEY, projectId: 'project-same', tenantId: 'tenant-1' })
    const { h } = await runWith(
      { env: { NEBIUS_PROJECT_ID: 'project-same' }, script: { select: ['sa-key'] } },
      (auth) => auth.configure(profile, undefined),
    )
    expect(h.interaction.asked()).toEqual(['select: Nebius authentication method'])
    expect(h.minted).toHaveLength(1)
  })

  test('no NEBIUS_PROJECT_ID means no mismatch prompt either', async () => {
    const profile = newProfile()
    storedForOld(profile)
    const { h } = await runWith({ script: { select: ['sa-key'] } }, (auth) => auth.configure(profile, undefined))
    expect(h.interaction.asked()).toEqual(['select: Nebius authentication method'])
    expect(h.minted).toHaveLength(1)
  })
})

describe('AuthProvider.logout (stored)', () => {
  test('removes the stored API key and says so', async () => {
    const profile = newProfile()
    writeCredential(profile, 'nebius-stored', { type: 'apiKey', apiKey: 'k' })
    const { h, result } = await runWith({}, (auth) => auth.logout(profile, { method: 'stored' }))
    expect(result._tag).toBe('Success')
    // Note: this one message has no trailing period (the other three logout messages do) — pinned
    // as-is, because the exact text is what a user greps for.
    expect(h.interaction.notes.map((note) => note.message)).toContain('Nebius: stored credentials removed')
    expect(() => readCredential(profile, 'nebius-stored')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// A credential write that fails (read-only / corrupt credentials dir)
// ---------------------------------------------------------------------------

/**
 * Put a DIRECTORY where the credential file must go, so the write fails with EISDIR.
 *
 * The store already wraps its own read/write failures as `AuthError`s ("Could not write credentials
 * at '<path>'"), which is the failure a user actually hits (a corrupt or read-only credentials dir)
 * — those messages are pinned below.
 *
 * ⚠️ `toAuthError`'s "Nebius credentials could not be saved" fallback is the **chmod-failure** arm
 * (`writeSecureCredentials` surfaces a post-write `chmod 0600` failure as a `PlatformError`, the one
 * error the auth contract cannot carry). That arm is unreachable in a test without root: chmodding a
 * file you own always succeeds, so the mutation report lists it as surviving — deliberately, not
 * for lack of trying.
 */
const blockCredentialWrite = (profile: string, key: string) =>
  mkdirSync(credentialPath(profile, key), { recursive: true })

describe('AuthProvider credential-write failures', () => {
  test('login reports a failed save instead of a PlatformError', async () => {
    const profile = newProfile()
    blockCredentialWrite(profile, 'nebius-stored')
    const { result } = await runWith({ script: { password: ['typed'] } }, (auth) =>
      auth.login(profile, { method: 'stored' }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect((result.failure as AuthError).message).toBe('login failed')
      // The store reads before it writes, so a directory at the path fails the READ first.
      expect(failureCause(result.failure).message).toContain('Could not read credentials at')
    }
  })

  test('configure reports a failed save with the same message', async () => {
    const profile = newProfile()
    blockCredentialWrite(profile, 'nebius-stored')
    const { result } = await runWith({ script: { select: ['stored'], password: ['typed'] } }, (auth) =>
      auth.configure(profile, undefined),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect((result.failure as AuthError).message).toContain('Could not write credentials at')
      // The path is named, which is the only way to act on it.
      expect((result.failure as AuthError).message).toContain('nebius-stored.json')
    }
  })

  test('configureWith reports a failed save too', async () => {
    const profile = newProfile()
    blockCredentialWrite(profile, 'nebius-stored')
    const { result } = await runWith({}, (auth) =>
      auth.configureWith(profile, { method: 'stored', values: { apiKey: 'k' } }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect((result.failure as AuthError).message).toContain('Could not write credentials at')
  })

  test('a hand-edited document is rejected with a reconfigure command, not a crash', async () => {
    const profile = newProfile()
    // The store round-trips every document through a codec (alchemy ≥ beta.77), so a stale or
    // hand-edited file fails on READ with the file named and the exact command to fix it — this is
    // the contract that stops a malformed document from reaching provider code.
    writeCredential(profile, 'nebius-sa-key', { nonsense: true })
    const { result } = await runWith({}, (auth) => auth.read(profile, { method: 'sa-key' }))

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const message = (result.failure as AuthError).message
      expect(message).toContain(`Stored credentials at '${credentialPath(profile, 'nebius-sa-key')}'`)
      expect(message).toContain('do not match the expected shape')
      expect(message).toContain(`alchemy profile edit --profile ${profile} --reconfigure nebius-sa-key`)
    }
  })

  test('an AuthError cause passes through unwrapped (it is already actionable)', async () => {
    // `configureWith --set sa-key` with no material: `readSaKey` fails with an AuthError, which
    // `toAuthError` must return unchanged rather than relabelling as a save failure.
    const { result } = await runWith({}, (auth) =>
      auth.configureWith(newProfile(), { method: 'sa-key', values: {} }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const message = (result.failure as AuthError).message
      expect(message).toContain('Nebius service-account key credentials not found.')
      expect(message).not.toContain('could not be saved')
    }
  })
})
