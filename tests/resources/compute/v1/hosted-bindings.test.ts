/**
 * The REAL binding host — `Nebius.compute.v1.Instance` — with NO mocks.
 *
 * Every other binding test injects `Self` by hand
 * (`Layer.succeed(Self, mockHost)`), which proves the test harness and not the
 * host. This file exercises the actual `Platform`-constructed instance:
 *
 *   host resolution — `Binding.Host` inside the instance's init Effect must
 *     resolve to the instance itself (`Type: Nebius.compute.v1.Instance`).
 *     If it resolved `undefined`, the binding's deploy-time branch
 *     (`if (!globalThis.__ALCHEMY_RUNTIME__ && host !== undefined)`) would be
 *     SILENTLY SKIPPED — no IAM grant, no env injection, and the failure would
 *     only appear at runtime as "Missing Nebius S3 env bindings".
 *
 *   payload contract — the registered binding must carry the instance shape
 *     `{ env, policyStatements: [] }` (the EC2 precedent), NOT the Cloudflare
 *     `{ bindings: [...] }` shape.
 *
 *   env-file seam — every S3 env name the binding registers must survive into
 *     `hostedEnv()` (the shipped systemd EnvironmentFile); the merge itself is
 *     unit-tested in `hosted.test.ts`.
 *
 * PLAN-ONLY — no cloud calls, no SLOW_TESTS, no mocks. Asserts on the plan's
 * binding records for the instance node, using a minimal providers layer
 * (collection + succeed layers only, NO gRPC/auth layers) — the same technique
 * as `hosted-orphans.test.ts`.
 *
 * WHERE BINDINGS MUST LIVE: yield them in the **impl** (3rd) argument. The
 * props Effect (2nd argument) runs OUTSIDE the `Self` context that
 * `Platform.ts` provides (`Layer.succeed(Self, instance)` around `impl`), so a
 * binding yielded there resolves no host and is silently skipped — see the
 * last test, which pins that behavior so nobody "simplifies" a binding into
 * the props Effect.
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { NodeFileSystem } from '@effect/platform-node'
import { expect } from 'bun:test'
import * as Test from 'alchemy/Test/Bun'
import * as AlchemyProvider from 'alchemy/Provider'
import * as Binding from 'alchemy/Binding'
import * as Nebius from '@fllstck/nebius-alchemy'
import { HttpServerResponse } from 'effect/unstable/http'

import * as BucketResource from '../../../../modules/resources/storage/v1/bucket.ts'
import * as ServiceAccountResource from '../../../../modules/resources/iam/v1/service-account.ts'
import * as GroupResource from '../../../../modules/resources/iam/v1/group.ts'
import * as GroupMembershipResource from '../../../../modules/resources/iam/v1/group-membership.ts'
import * as AccessKeyResource from '../../../../modules/resources/iam/v2/access-key.ts'
import * as AccessPermitResource from '../../../../modules/resources/iam/v1/access-permit.ts'
import * as InstanceResource from '../../../../modules/resources/compute/v1/instance.ts'
import * as EndpointResource from '../../../../modules/resources/ai/v1/endpoint.ts'

class TestProviders extends AlchemyProvider.ProviderCollection<TestProviders>()('NebiusTest') {}

const planningProviders = () =>
  Layer.effect(
    TestProviders,
    AlchemyProvider.collection([
      BucketResource.NebiusBucket,
      ServiceAccountResource.NebiusServiceAccount,
      GroupResource.NebiusGroup,
      GroupMembershipResource.NebiusGroupMembership,
      AccessKeyResource.NebiusAccessKey,
      AccessPermitResource.NebiusAccessPermit,
      InstanceResource.NebiusInstance,
      EndpointResource.NebiusEndpoint,
    ]),
  ).pipe(
    Layer.provideMerge(BucketResource.NebiusBucketProvider),
    Layer.provideMerge(ServiceAccountResource.NebiusServiceAccountProvider),
    Layer.provideMerge(GroupResource.NebiusGroupProvider),
    Layer.provideMerge(GroupMembershipResource.NebiusGroupMembershipProvider),
    Layer.provideMerge(AccessKeyResource.NebiusAccessKeyProvider),
    Layer.provideMerge(AccessPermitResource.NebiusAccessPermitProvider),
    Layer.provideMerge(InstanceResource.NebiusInstanceProvider),
    Layer.provideMerge(EndpointResource.NebiusEndpointProvider),
  )

// oxlint-disable-next-line no-explicit-any — Test.make options are untyped (see tests/helpers/stack.ts)
const { test } = Test.make({ providers: planningProviders() as any })

const hostedInstanceProps = {
  serviceAccountId: 'sa-abc123',
  resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
  bootDisk: {
    attachMode: 'READ_WRITE',
    managedDisk: {
      name: 'boot-disk',
      spec: {
        type: 'NETWORK_SSD',
        sizeGibibytes: 64,
        sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
      },
    },
  },
  networkInterfaces: [{ subnetId: 'subnet-abc123', name: 'eth0', ipAddress: { allocationId: '' } }],
} as const

const bucketProps = {
  versioningPolicy: 'DISABLED',
  defaultStorageClass: 'STANDARD',
  objectAuditLogging: 'NONE',
  forceStorageClass: false,
} as const

/** The AI endpoint's shape (the proven vLLM Qwen3-0.6B config); the subnet id is a plan-time placeholder. */
const endpointProps = {
  image: 'vllm/vllm-openai:v0.19.1',
  containerCommand: 'python3',
  args: '-m vllm.entrypoints.openai.api_server --model Qwen/Qwen3-0.6B --host 0.0.0.0 --port 8000',
  platform: 'gpu-l40s-a',
  preset: '1gpu-8vcpu-32gb',
  publicIp: true,
  preemptible: true,
  environmentVariables: [],
  ports: [{ containerPort: 8000, protocol: 'HTTP' }],
  volumes: [],
  disk: { type: 'NETWORK_SSD', sizeBytes: 107_374_182_400 },
  shmSizeBytes: 17_179_869_184,
  authToken: 'plan-time-token',
} as const

/** The fixture the instance bundles — a real path, so the diff's content re-bundle succeeds. */
const FIXTURE_MAIN = new URL('../../../fixtures/hosted-instance-program.ts', import.meta.url).href

/** The S3 env names the instance must receive for the binding to work at runtime. */
const S3_ENV_NAMES = [
  'NEBIUS_S3_ENDPOINT',
  'NEBIUS_REGION',
  'NEBIUS_ACCESS_KEY_ID',
  'NEBIUS_SECRET_ACCESS_KEY',
  'NEBIUS_BUCKET_NAME',
] as const

test.provider('a real hosted Instance resolves Binding.Host to itself (no mock)', (stack) =>
  Effect.gen(function* () {
    let hostInsideImpl: { Type?: string; LogicalId?: string } | undefined

    const plan = yield* stack.plan(
      Effect.gen(function* () {
        const bucket = yield* Nebius.storage.Bucket('Assets', bucketProps)
        const endpoint = yield* Nebius.ai.Endpoint('Llm', { ...endpointProps, subnetId: 'subnet-abc123' })

        yield* Nebius.compute.Instance(
          'Api',
          { ...hostedInstanceProps, main: '/tmp/entry.ts' },
          Effect.gen(function* () {
            // The host `Binding.Host` resolves — this is what every binding impl reads.
            hostInsideImpl = (yield* Binding.Host) as { Type?: string; LogicalId?: string } | undefined

            // The REAL binding impls, on the real host — both capabilities.
            yield* Nebius.storage.GetObject(bucket).pipe(Effect.provide(Nebius.storage.GetObjectHttp))
            yield* Nebius.ai.ChatCompletions(endpoint).pipe(Effect.provide(Nebius.ai.ChatCompletionsHttp))

            return { fetch: Effect.succeed(HttpServerResponse.text('ok')) }
          }),
        )
      }),
    )

    // 1. The instance is its own binding host.
    expect(hostInsideImpl?.Type).toBe('Nebius.compute.v1.Instance')
    expect(hostInsideImpl?.LogicalId).toBe('Api')

    // 2. Exactly one binding record, on the instance node, with the instance payload.
    const apiNode = plan.resources['Api']
    expect(apiNode).toBeDefined()

    const bindingRow = apiNode!.bindings.find((row) => row.sid === 'Nebius.storage.v1.Bucket.GetObject')
    expect(bindingRow).toBeDefined()
    expect(bindingRow!.action).toBe('create')

    const data = bindingRow!.data as { env?: Record<string, unknown>; policyStatements?: unknown }
    // The EC2-compatible contract, and NOT the Cloudflare `{ bindings: [...] }` shape.
    expect(data.policyStatements).toEqual([])
    expect('bindings' in data).toBe(false)

    // 3. Every S3 env name is registered — the Output-valued ones stay intact and
    //    are resolved by the engine at apply time (`Output.evaluate(node.bindings)`).
    //    (JSON-serializing the record hides unresolved Outputs, so compare keys.)
    expect(Object.keys(data.env ?? {}).toSorted()).toEqual([...S3_ENV_NAMES].toSorted())
    expect(data.env?.NEBIUS_S3_ENDPOINT).toBe('https://storage.eu-north1.nebius.cloud')
    expect(data.env?.NEBIUS_REGION).toBe('eu-north1')

    // 3b. The host identity must be declared EXACTLY ONCE. `transformProps`
    //     declares it (inside `Namespace.push(id)`) and the binding impl declares
    //     it again — if those two land on different FQNs the host gets two SAs,
    //     two groups and two AccessKeys with the SAME physical name, and the
    //     second create dies with ALREADY_EXISTS on real infra (observed
    //     2026-09-10). Hence `hostIdentity` pins the namespace.
    const identityFqns = Object.keys(plan.resources).filter((fqn) => fqn.endsWith('BindingSA'))
    expect(identityFqns).toEqual(['Api/ApiBindingSA'])

    // 4. The second capability (AI) dispatches to the SAME instance payload shape.
    const aiRow = apiNode!.bindings.find((row) => row.sid === 'Nebius.ai.v1.Endpoint.ChatCompletions')
    expect(aiRow).toBeDefined()
    const aiData = aiRow!.data as { env?: Record<string, unknown>; policyStatements?: unknown; bindings?: unknown }
    expect(aiData.policyStatements).toEqual([])
    expect('bindings' in aiData).toBe(false)
    expect(Object.keys(aiData.env ?? {}).toSorted()).toEqual([
      'NEBIUS_ENDPOINT_AUTH_TOKEN',
      'NEBIUS_ENDPOINT_URL',
    ])
  }),
)

/**
 * REGRESSION — the diff gate must ignore `exports`, which is an Effect.
 *
 * A host runtime context always exposes `exports` as an Effect
 * (`Server/Process.ts`), `Platform` folds it onto props for every inline init
 * Effect, and `AlchemyDiff.isResolved` reports any Effect as unresolved. Gating
 * the whole prop bag on `isResolved` therefore made every diff return
 * `undefined` (noop) for inline-impl instances — the form bindings require —
 * silently disabling code-change detection.
 *
 * Called directly on the provider so the only thing under test is the gate:
 * identical props except a STALE `code.hash`, so the content re-bundle must
 * plan an `update`.
 */
test.provider('the diff gate ignores `exports` — an inline init Effect still plans updates', () =>
  Effect.gen(function* () {
    const provider = yield* InstanceResource.NebiusInstance.Provider
    const result = yield* provider
      .diff!({
        id: 'Api',
        fqn: 'Api',
        instanceId: 'test-instance',
        olds: { ...hostedInstanceProps, main: FIXTURE_MAIN },
        // `exports` is not part of the props type (Platform folds it on at
        // runtime), and the attribute ids are branded — cast both.
        news: { ...hostedInstanceProps, main: FIXTURE_MAIN, exports: { program: Effect.void } } as never,
        oldBindings: [],
        newBindings: [],
        output: { id: 'instance-seeded', code: { hash: 'stale-hash' } } as never,
      })
      .pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(Path.layer))

    // Without the `exports`-excluding gate this is `undefined` (noop): the
    // stale `code.hash` would never be compared against a fresh bundle hash.
    expect(result === undefined ? undefined : result.action).toBe('update')
  }),
)

/**
 * Pins the footgun: bindings must be yielded in the **impl** argument. In the
 * props Effect no host is ambient, so the wiring is skipped without an error.
 */
test.provider('a binding yielded in the props Effect resolves NO host (must live in the impl)', (stack) =>
  Effect.gen(function* () {
    let hostInsideProps: unknown = 'untouched'

    yield* stack.plan(
      Effect.gen(function* () {
        yield* Nebius.storage.Bucket('Assets', bucketProps)
        yield* Nebius.compute.Instance(
          'Api',
          Effect.gen(function* () {
            hostInsideProps = yield* Binding.Host
            return { ...hostedInstanceProps, main: '/tmp/entry.ts' }
          }),
          Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text('ok')) }),
        )
      }),
    )

    expect(hostInsideProps).toBeUndefined()
  }),
)
