/**
 * The hosted-instance e2e program (the `main` the VM bundles and runs).
 *
 * DEEP IMPORTS ONLY (house style: the package index pulls the whole provider
 * surface). Note the measured reality — this bundle is 27 files / ~5.2 MB
 * including `grpc-js`, `rolldown` and `postcss`: deep imports alone do NOT
 * remove the deploy graph, because `instance.ts` statically reaches
 * `hosted.ts → alchemy/Bundle` (rolldown/vite/postcss) and the gRPC
 * api-client, and those modules survive tree-shaking. This is the same
 * open question the D8 bundle harness tracks in TASKS.md — an instance bundle
 * is a fourth data point for it, not a new bug.
 *
 * Phase split: this file is bundled but NOT executed by the CLI — its props
 * Effect runs at deploy (Config captures → shipped env) and again at cold start
 * on the VM. The bindings this program consumes are registered by the
 * DEPLOY-side instance declaration (the e2e test's init Effect), which is what
 * puts `NEBIUS_S3_*` into the shipped env file via `hostedEnv`.
 */
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { createHash } from 'node:crypto'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { NebiusInstance } from '@fllstck/nebius-alchemy/resources/compute/v1/instance.ts'
import { ServiceAccountId } from '@fllstck/nebius-alchemy/resources/iam/v1/ids.ts'
import { SubnetId } from '@fllstck/nebius-alchemy/resources/vpc/v1/ids.ts'
import { NebiusEndpoint } from '@fllstck/nebius-alchemy/resources/ai/v1/endpoint.ts'
import {
  ChatCompletions,
  ChatCompletionsHttp,
} from '@fllstck/nebius-alchemy/resources/ai/v1/bindings.ts'
import { ChatCompletionRequest } from '@fllstck/nebius-alchemy/resources/ai/v1/bindings.schema.ts'
import { runDiskName } from '../helpers/run-token.ts'

const ROUND_TRIP_KEY = 'hosted-binding-roundtrip.txt'
const ROUND_TRIP_VALUE = 'hello-from-binding'

/** The model the deploy side serves (nginx ignores it; vLLM rejects others). */
const MODEL = 'Qwen/Qwen3-0.6B'

/** One chat call through the TYPED binding client — the outcome as a string. */
const typedChat = (
  chat: (request: ChatCompletionRequest) => Effect.Effect<unknown, { readonly _tag: string }>,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(chat(new ChatCompletionRequest({ model: MODEL, messages: [] })))
    if (Result.isFailure(outcome)) return `error:${outcome.failure._tag}`
    const result = outcome.success as { stream: boolean }
    return result.stream ? 'ok:stream' : 'ok:completion'
  })

/**
 * A real call to the bound AI endpoint — proves the injected URL is the MANAGED
 * https URL (not the raw `IP:port` that broke `new URL` once, AD1) and that the
 * bearer token is usable from the VM. Never throws; the outcome is reported.
 */
const aiProbe = async (): Promise<string> => {
  const url = process.env.NEBIUS_ENDPOINT_URL
  const token = process.env.NEBIUS_ENDPOINT_AUTH_TOKEN
  if (!url || !token) return 'skipped'
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    return `ok:${response.status}`
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`
  }
}

/** The AI binding's env — `url: null` when the binding did not reach the VM. */
const aiReport = (probe: string, typed: string, typedBadToken: string) => ({
  url: process.env.NEBIUS_ENDPOINT_URL ?? null,
  hasToken: Boolean(process.env.NEBIUS_ENDPOINT_AUTH_TOKEN),
  tokenShape: shape(process.env.NEBIUS_ENDPOINT_AUTH_TOKEN),
  // Plain `fetch` with the injected values (URL/token usability).
  probe,
  // The TYPED binding client, running on the VM: its tagged-error mapping is
  // only unit-covered otherwise. Against nginx this is `EndpointNotFound`;
  // against vLLM it returns a completion.
  typed,
  // The same call with a deliberately wrong bearer token — the 401 path.
  typedBadToken,
})

/** Shape-only diagnostics — never the secret itself. A JSON-serialized Output (i.e. an UNRESOLVED value) is the failure mode this reports. */
const shape = (value: string | undefined): string =>
  value === undefined || value === ''
    ? 'absent'
    : `${value.length}ch${value.startsWith('{') ? ':JSON-LOOKING' : ''}`

/** Short digest of the secret — lets the test prove the VALUE matched without shipping it. */
const sha = (value: string | undefined): string | null =>
  value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null

/** The S3 env the BINDING injected — `null` when the binding did not reach the VM. */
const s3Report = () => ({
  endpoint: process.env.NEBIUS_S3_ENDPOINT ?? null,
  bucket: process.env.NEBIUS_BUCKET_NAME ?? null,
  hasAccessKey: Boolean(process.env.NEBIUS_ACCESS_KEY_ID && process.env.NEBIUS_SECRET_ACCESS_KEY),
  keyIdPrefix: process.env.NEBIUS_ACCESS_KEY_ID?.slice(0, 10) ?? null,
  region: process.env.NEBIUS_REGION ?? null,
  secretShape: shape(process.env.NEBIUS_SECRET_ACCESS_KEY),
  secretSha256: sha(process.env.NEBIUS_SECRET_ACCESS_KEY),
})

/**
 * A real S3 round-trip through exactly those env values — proves both halves of
 * the binding: the identity's key was injected AND `grantBucketAccess` gave it
 * write access. Never throws: the outcome is reported in the response body.
 *
 * RETRIES: newly minted Nebius access keys/permissions take time to propagate to
 * the S3 front end, and a cold-start probe right after boot can land inside that
 * window (observed: "The authorization header that you provided is not valid."
 * on the first attempt). A persistent failure across all attempts is a real
 * credential/grant bug; a later success means we only raced propagation — the
 * report says which.
 */
const ATTEMPTS = 8
const RETRY_DELAY_MS = 15_000

const s3RoundTrip = async (): Promise<string> => {
  const env = process.env
  if (
    !env.NEBIUS_S3_ENDPOINT ||
    !env.NEBIUS_BUCKET_NAME ||
    !env.NEBIUS_ACCESS_KEY_ID ||
    !env.NEBIUS_SECRET_ACCESS_KEY
  ) {
    return 'skipped'
  }
  const client = new S3Client({
    endPoint: env.NEBIUS_S3_ENDPOINT,
    region: env.NEBIUS_REGION ?? 'eu-north1',
    accessKey: env.NEBIUS_ACCESS_KEY_ID,
    secretKey: env.NEBIUS_SECRET_ACCESS_KEY,
    bucket: env.NEBIUS_BUCKET_NAME,
    pathStyle: true,
  })

  let lastError = ''
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await client.putObject(ROUND_TRIP_KEY, ROUND_TRIP_VALUE, { metadata: { 'Content-Type': 'text/plain' } })
      const response = await client.getObject(ROUND_TRIP_KEY)
      const text = await response.text()
      // Delete it again: a non-empty bucket is undeletable, which would turn the
      // test's bucket into a leak at destroy time.
      await client.deleteObject(ROUND_TRIP_KEY)
      return attempt === 1 ? `ok:${text}` : `ok:${text} (attempt ${attempt})`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
  return `error:${lastError} (${ATTEMPTS} attempts)`
}

export default NebiusInstance(
  'HostedTestInstance',
  Effect.gen(function* () {
    const subnetId = yield* Effect.orDie(
      Config.String('HOSTED_TEST_SUBNET_ID').pipe(Config.withDefault('')),
    )
    const serviceAccountId = yield* Effect.orDie(
      Config.String('HOSTED_TEST_SA_ID').pipe(Config.withDefault('')),
    )
    return {
      main: import.meta.url,
      // Branded at the boundary: these are read from the shipped env, where an
      // empty value is the "not shipped" fallback (props are validated on the
      // VM even though no API call is made there). `ServiceAccountId.make('')`
      // would throw — its `serviceaccount-` refinement rejects the empty string
      // — hence the explicit empty arm (the props schema accepts it too).
      serviceAccountId: serviceAccountId === '' ? '' : ServiceAccountId.make(serviceAccountId),
      resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
      bootDisk: {
        attachMode: 'READ_WRITE',
        managedDisk: {
          name: runDiskName('boot-disk'),
          // Nebius enforces a 64 GiB boot-disk floor — smaller disks hang
          // provisioning (cloud-init never runs). The image is REQUIRED
          // (blank disk = no OS); the platform resolves the family. At the VM
          // these props never hit the API, but plan-side validation still
          // requires an image, so the fixture stays valid.
          spec: {
            type: 'NETWORK_SSD',
            sizeGibibytes: 64,
            sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
          },
        },
      },
      networkInterfaces: [{ subnetId: SubnetId.make(subnetId), name: 'eth0', ipAddress: { allocationId: '' } }],
      port: 3000,
      // The shipped env file carries this — the program echoes it back so the
      // integration test can assert the env landed on the VM.
      env: { HOSTED_TEST_ECHO: 'hello-from-env' },
    }
  }),
  Effect.gen(function* () {
    // Runs at cold start on the VM (nothing executes this at deploy — the
    // deploy-side binding registration lives in the e2e test's init Effect).
    const roundTrip = yield* Effect.promise(s3RoundTrip)
    const ai = yield* Effect.promise(aiProbe)

    // The TYPED client on the VM: `ref` is just a handle (the runtime client
    // reads the injected env), and the layer provides the implementation.
    const endpoint = yield* NebiusEndpoint.ref('llm')
    const chat = yield* ChatCompletions(endpoint).pipe(Effect.provide(ChatCompletionsHttp))
    const typed = yield* typedChat(chat)

    // Error path: the same call with a wrong token. `runtimeEnv` hands back
    // `process.env` itself on an instance host, so the override is visible to
    // the client — restored immediately after the call.
    const savedToken = process.env.NEBIUS_ENDPOINT_AUTH_TOKEN
    process.env.NEBIUS_ENDPOINT_AUTH_TOKEN = 'deliberately-wrong-token'
    const typedBadToken = yield* typedChat(chat).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (savedToken === undefined) delete process.env.NEBIUS_ENDPOINT_AUTH_TOKEN
          else process.env.NEBIUS_ENDPOINT_AUTH_TOKEN = savedToken
        }),
      ),
    )

    return {
      // Per-request body: `now` is the request-time clock (skew check), while
      // `roundTrip`/`ai` are the cold-start results.
      fetch: Effect.sync(() =>
        HttpServerResponse.json({
          ok: true,
          echo: process.env.HOSTED_TEST_ECHO ?? '',
          s3: s3Report(),
          ai: aiReport(ai, typed, typedBadToken),
          roundTrip,
          now: new Date().toISOString(),
        }),
      ),
    }
  }),
)
