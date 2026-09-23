/**
 * What shape does `PricingPolicyService/Update` actually want?
 *
 * Both earlier attempts were refused with a bare `3 INVALID_ARGUMENT: Request validation error`:
 * `{metadata: {id, resourceVersion}}` + full spec, and `{metadata: {id, parentId, resourceVersion}}` + a
 * pricing-only spec. So this sends the same change a handful of ways and prints each error verbatim —
 * the exact required shape is provider #41's `reconcile` payload, and guessing it in production code
 * would have meant a deploy that fails at apply time with no clue.
 *
 * No VM: one policy, created and deleted here.
 *
 *   bun spikes/billing-update-shape-probe.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import Long from 'long'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as GrpcUtils from '../modules/api-client/grpc-utils.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as MetadataSchema from '../schemas/nebius/common/v1/metadata.ts'
import * as PricingPolicySchema from '../schemas/nebius/billing/v1/pricing_policy.ts'
import * as ServiceSchema from '../schemas/nebius/billing/v1/pricing_policy_service.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const POLICY_NAME = 'alchemy-billing-update-probe'
const PLATFORM = 'gpu-h100-sxm'

const authLayer = Layer.mergeAll(ProfileStoreLive, NebiusAuthModule.NebiusAuth).pipe(
  Layer.provide(CredentialsStoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      PlatformNode.NodeServices.layer,
      SaTokenModule.SaTokenMinterLive,
      SaBootstrapModule.SaBootstrapLive,
    ),
  ),
)

const sleep = (seconds: number) => Effect.sleep(`${seconds} seconds`)
const stamp = () => new Date().toISOString().slice(11, 19)
const log = (label: string, value: unknown) =>
  console.log(`\n[${stamp()}] == ${label} ==\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

const program = Effect.gen(function* () {
  const policies = yield* GrpcUtils.makeGrpcService(ServiceSchema.PricingPolicyServiceClient)

  const listed = yield* policies.list(
    ServiceSchema.ListPricingPoliciesRequest.fromPartial({ parentId: PROJECT_ID, pageSize: Long.fromNumber(100) }),
  )
  if (listed.items.length > 0) {
    console.error('ABORT — pricing policies already exist; the environment is not clean.')
    return
  }

  const create = ServiceSchema.CreatePricingPolicyRequest.fromPartial({
    metadata: { parentId: PROJECT_ID, name: POLICY_NAME },
    spec: { computeInstanceSpec: { v1: { platform: PLATFORM } }, pricing: { maxPriceV1: { maxPrice: '3.000' } } },
  })
  yield* policies.create(create).pipe(
    Effect.tap(() => Effect.sync(() => console.log('  create ACCEPTED'))),
    Effect.catch((error) => Effect.sync(() => console.error(`  create REJECTED: ${String(error).slice(0, 200)}`))),
  )
  // Wait for STATE_ACTIVE, then read a fresh resourceVersion for every variant below.
  let policy: PricingPolicySchema.PricingPolicy | undefined
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = yield* policies
      .getByName(MetadataSchema.GetByNameRequest.fromPartial({ parentId: PROJECT_ID, name: POLICY_NAME }))
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (found !== undefined && found.status?.state === PricingPolicySchema.PricingPolicyStatus_State.STATE_ACTIVE) {
      policy = found
      break
    }
    yield* sleep(3)
  }
  if (policy === undefined) {
    console.error('ABORT — the policy never became ACTIVE.')
    return
  }
  const id = policy.metadata!.id
  log('created and ACTIVE', { id, resourceVersion: policy.metadata?.resourceVersion?.toString(), spec: policy.spec })

  const fullSpec = {
    computeInstanceSpec: { v1: { platform: PLATFORM } },
    pricing: { maxPriceV1: { maxPrice: '3.000' } },
  }
  const pricingOnly = { pricing: { maxPriceV1: { maxPrice: '3.000' } } }
  const pricingChanged = { pricing: { maxPriceV1: { maxPrice: '3.500' } } }

  /** A variant is a label plus the request factory (built against a *freshly read* resourceVersion). */
  const variants: ReadonlyArray<{ label: string; request: (fresh: PricingPolicySchema.PricingPolicy) => unknown }> = [
    {
      label: 'v1: {id, parentId, rv} + full spec, UNCHANGED values',
      request: (fresh) => ({
        metadata: { id, parentId: PROJECT_ID, resourceVersion: fresh.metadata!.resourceVersion.toString() },
        spec: fullSpec,
      }),
    },
    {
      label: 'v2: {id, parentId, rv} + pricing only, UNCHANGED value',
      request: (fresh) => ({
        metadata: { id, parentId: PROJECT_ID, resourceVersion: fresh.metadata!.resourceVersion.toString() },
        spec: pricingOnly,
      }),
    },
    {
      label: 'v3: {id, parentId, rv} + pricing only, CHANGED value (3.500)',
      request: (fresh) => ({
        metadata: { id, parentId: PROJECT_ID, resourceVersion: fresh.metadata!.resourceVersion.toString() },
        spec: pricingChanged,
      }),
    },
    {
      label: 'v4: {name, parentId, rv} + pricing only (name-identified, like GetByName)',
      request: (fresh) => ({
        metadata: { name: POLICY_NAME, parentId: PROJECT_ID, resourceVersion: fresh.metadata!.resourceVersion.toString() },
        spec: pricingOnly,
      }),
    },
    {
      label: 'v5: {id, resourceVersion} only + pricing only (run-1 shape)',
      request: (fresh) => ({
        metadata: { id, resourceVersion: fresh.metadata!.resourceVersion.toString() },
        spec: pricingOnly,
      }),
    },
    {
      label: 'v6: {id, parentId} without resourceVersion + pricing only',
      request: () => ({ metadata: { id, parentId: PROJECT_ID }, spec: pricingOnly }),
    },
    {
      label: 'v7: {id, parentId, rv} + pricing only, price = "3" (as the API echoes it)',
      request: (fresh) => ({
        metadata: { id, parentId: PROJECT_ID, resourceVersion: fresh.metadata!.resourceVersion.toString() },
        spec: { pricing: { maxPriceV1: { maxPrice: '3' } } },
      }),
    },
  ]

  for (const variant of variants) {
    const fresh = yield* policies.get(
      ServiceSchema.GetPricingPolicyRequest.fromPartial({ id }),
    )
    const request = ServiceSchema.UpdatePricingPolicyRequest.fromPartial(
      variant.request(fresh) as ServiceSchema.UpdatePricingPolicyRequest,
    )
    const result = yield* policies.update(request).pipe(
      Effect.map(() => 'ACCEPTED'),
      Effect.catch((error) => Effect.succeed(`REJECTED ${String(error).slice(0, 260)}`)),
    )
    console.log(`  ${variant.label} → ${result}`)
    if (result === 'ACCEPTED') {
      const after = yield* policies.get(ServiceSchema.GetPricingPolicyRequest.fromPartial({ id })).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      console.log(`      spec now: ${JSON.stringify(after?.spec)} rv=${after?.metadata?.resourceVersion}`)
    }
  }

  // Teardown.
  const [instances, policiesAfter] = yield* Effect.all([
    Effect.succeed([]),
    policies
      .list(ServiceSchema.ListPricingPoliciesRequest.fromPartial({ parentId: PROJECT_ID, pageSize: Long.fromNumber(100) }))
      .pipe(Effect.map((response) => response.items)),
  ])
  yield* policies
    .delete(ServiceSchema.DeletePricingPolicyRequest.fromPartial({ id }))
    .pipe(
      Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] cleanup — policy deleted: ${id}`))),
      Effect.catch((error) =>
        Effect.sync(() => console.error(`cleanup FAILED — delete the policy by hand: ${id}: ${String(error)}`)),
      ),
    )
  yield* sleep(5)
  const remaining = yield* policies
    .list(ServiceSchema.ListPricingPoliciesRequest.fromPartial({ parentId: PROJECT_ID, pageSize: Long.fromNumber(100) }))
    .pipe(Effect.map((response) => response.items.map((item) => item.metadata?.name)))
  log('POSTFLIGHT', { instances: instances.length, pricingPolicies: remaining, seenAtStart: policiesAfter.length })
})

const layer = NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
console.log(`\n[${stamp()}] PROBE DONE`)
