/**
 * `pricing` at the API — the cheap half of the two props I shipped as "unmeasured" (2026-09-24).
 *
 * The `pricing` props are table- and unit-pinned, but three API facts were never observed and each is
 * written into the props as a caveat. Two of them need no preemptible VM (this tenant's CPU platforms
 * reject `Preemptible is invalid`, measured 2026-09-10), so they are cheap to settle:
 *
 *   A. **Does `compute/v1 Instance` accept the reshaped arm at all?** The prop is a reshape of a flat
 *      oneof — `onDemand: {}` is sent as a sibling of `resources`/`bootDisk`, not under a `pricing` key.
 *      If the API ignored it, the reshape would be wrong and every pin would be a silent no-op.
 *   B. **Does the platform materialize a default, and what does "absent" mean for it?** Read the spec
 *      after a create that pinned `onDemand`, then send an update that **omits** it (exactly what the
 *      props build when a user removes the line) and read the spec again. Materialization is what the
 *      news-side guard in `instanceSpecDrifted` protects against; this says whether that guard is
 *      load-bearing or belt-and-braces.
 *   C. **Is the API's preemptible coupling real?** The props enforce it at plan time (its doc comment:
 *      "Must match the preemptible flag"), which is only justified if the API refuses the mismatch.
 *   D. **`billing/v1 PricingPolicy` — the service the new brand points at.** Its endpoint was added from
 *      the upstream catalog, never called. A full CRUD pass here validates the endpoint, the request
 *      shapes and the status fields *and* hands back a real `pricingpolicy-…` id for arm C — no VM, so
 *      this part is free.
 *
 * The arm that cannot be completed here is a *successful* `spotPricingPolicy`: it needs a preemptible VM
 * (GPU spend). Arm C uses the id anyway, because a rejection is exactly the evidence the plan-time rule
 * needs.
 *
 *   bun spikes/compute-pricing-probe.ts 2>&1 | tee /tmp/compute-pricing-probe.log
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import Long from 'long'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as ComputeGrpcModule from '../modules/api-client/compute.ts'
import * as GrpcUtils from '../modules/api-client/grpc-utils.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as IamGrpcModule from '../modules/api-client/iam.ts'
import * as VpcGrpcModule from '../modules/api-client/vpc.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as InstanceSchema from '../schemas/nebius/compute/v1/instance.ts'
import * as PricingPolicySchema from '../schemas/nebius/billing/v1/pricing_policy.ts'
import * as PricingPolicyServiceSchema from '../schemas/nebius/billing/v1/pricing_policy_service.ts'
import * as MetadataSchema from '../schemas/nebius/common/v1/metadata.ts'

const { PricingPolicyStatus_State } = PricingPolicySchema

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { ComputeGrpcService, ComputeGrpcServiceLive } = ComputeGrpcModule
const { IamGrpcService, IamGrpcServiceLive } = IamGrpcModule
const { VpcGrpcService, VpcGrpcServiceLive } = VpcGrpcModule

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const SERVICE_ACCOUNT_ID = process.env.NEBIUS_SA_ID ?? 'serviceaccount-e00r4d1ae86rb4n03a'
const SUBNET_ID = process.env.NEBIUS_SUBNET_ID ?? 'vpcsubnet-e00rf5t1vkbq0ew96x'
const INSTANCE_NAME = 'alchemy-pricing-probe'
const POLICY_NAME = 'alchemy-pricing-probe-policy'
/** The advisor shows preemptible H100 capacity in this tenant, so it is the platform a bid can name. */
const POLICY_PLATFORM = 'gpu-h100-sxm'

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

const instanceSpecJson = (spec: InstanceSchema.InstanceSpec | undefined): unknown =>
  spec === undefined ? null : InstanceSchema.InstanceSpec.toJSON(spec)
const policyJson = (
  policy: PricingPolicySchema.PricingPolicy | undefined,
): { spec?: unknown; status?: unknown } | null =>
  policy === undefined
    ? null
    : (PricingPolicySchema.PricingPolicy.toJSON(policy) as { spec?: unknown; status?: unknown })

const pricingStatus = (policy: PricingPolicySchema.PricingPolicy) => ({
  state:
    policy.status === undefined
      ? null
      : PricingPolicySchema.pricingPolicyStatus_StateToJSON(policy.status.state),
  schedulingState:
    policy.status === undefined
      ? null
      : PricingPolicySchema.pricingPolicyStatus_SchedulingStateToJSON(policy.status.schedulingState),
  skuId: policy.status?.skuId ?? null,
  currency: policy.status?.currency ?? null,
  runningVmCount: policy.status?.runningVmCount?.toString() ?? null,
})

const instanceWitness = (compute: ComputeGrpcModule.ComputeGrpcServiceShape) =>
  Effect.gen(function* () {
    const rows = yield* compute.instance.list(PROJECT_ID)
    return rows.map((instance) => `${instance.metadata?.name}(${instance.metadata?.id})`)
  })

/**
 * Poll a policy until it leaves the transitional state the service reports while applying a change.
 *
 * The raw client returns an `Operation` from create/update (not the resource) and this probe has no
 * operation-polling wrapper — the repo's `wrapWithOperationPolling` is the production path, and the
 * resource's own `status.state` is the same evidence (`STATE_CREATING`/`STATE_UPDATING` → `STATE_ACTIVE`).
 */
const waitForPolicy = (
  fetch: () => Effect.Effect<PricingPolicySchema.PricingPolicy, unknown>,
  label: string,
  limitSeconds = 90,
) =>
  Effect.gen(function* () {
    const until = Date.now() + limitSeconds * 1000
    for (;;) {
      const found = yield* fetch().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (found !== undefined && found.status?.state === PricingPolicyStatus_State.STATE_ACTIVE) return found
      if (Date.now() > until) {
        console.log(`  (${label}) still not ACTIVE after ${limitSeconds}s: ${JSON.stringify(found === undefined ? null : pricingStatus(found))}`)
        return found
      }
      yield* sleep(5)
    }
  })

const program = Effect.gen(function* () {
  const compute = yield* ComputeGrpcService
  const iam = yield* IamGrpcService
  const vpc = yield* VpcGrpcService
  // Raw: `api-client/billing.ts` does not exist yet (that is provider #41's groundwork), and the point
  // of this part is to exercise the *catalog endpoint* this package now resolves for the service.
  const pricingPolicies = yield* GrpcUtils.makeGrpcService(PricingPolicyServiceSchema.PricingPolicyServiceClient)

  // ── Preflight ─────────────────────────────────────────────────────────────
  const instances = yield* instanceWitness(compute)
  const existingPolicies = yield* pricingPolicies
    .list(PricingPolicyServiceSchema.ListPricingPoliciesRequest.fromPartial({ parentId: PROJECT_ID, pageSize: Long.fromNumber(100) }))
    .pipe(
      Effect.map((response) => response.items.map((policy) => policy.metadata?.name ?? '?')),
      Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}` as const)),
    )
  log('PREFLIGHT', { instances, pricingPolicies: existingPolicies })
  if (instances.length > 0) {
    console.error('ABORT — instances already exist; the environment is not empty.')
    return
  }

  const subnet = yield* vpc.subnet.get(SUBNET_ID).pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  const sa = yield* iam.serviceAccount
    .get(SERVICE_ACCOUNT_ID)
    .pipe(Effect.catch((error) => Effect.sync(() => `ERROR: ${String(error)}`)))
  if (typeof subnet === 'string' || typeof sa === 'string') {
    console.error(`ABORT — need the pre-existing subnet and service account: ${String(subnet)} / ${String(sa)}`)
    return
  }

  let policyId: string | undefined
  let instanceId: string | undefined

  yield* Effect.gen(function* () {
    // ── D. PricingPolicy CRUD (no VM, so this part is free) ────────────────
    console.log(`\n${'─'.repeat(78)}\n[${stamp()}] D. billing/v1 PricingPolicyService — CRUD through the new endpoint\n${'─'.repeat(78)}`)
    // `max_price` must be inside the service's allowed range for the platform, and the range is not
    // published anywhere: try a ladder and stop at the first acceptance, printing every rejection (the
    // error text is the only place the bounds may appear).
    const policy = yield* Effect.gen(function* () {
      for (const maxPrice of ['3.000', '1.000', '0.500', '5.000', '10.000']) {
        const accepted = yield* pricingPolicies
          .create(
            PricingPolicyServiceSchema.CreatePricingPolicyRequest.fromPartial({
              metadata: { parentId: PROJECT_ID, name: POLICY_NAME },
              spec: {
                computeInstanceSpec: { v1: { platform: POLICY_PLATFORM } },
                pricing: { maxPriceV1: { maxPrice } },
              },
            }),
          )
          .pipe(
            Effect.tap(() => Effect.sync(() => console.log(`  create ACCEPTED with maxPrice=${maxPrice} (operation returned)`))),
            Effect.catch((error) =>
              Effect.sync(() => {
                console.log(`  create REJECTED with maxPrice=${maxPrice}: ${String(error).slice(0, 300)}`)
                return undefined
              }),
            ),
          )
        if (accepted !== undefined) {
          // The operation has no `.metadata` (it is not the resource) — read the policy by name instead.
          return yield* waitForPolicy(
            () =>
              pricingPolicies.getByName(
                MetadataSchema.GetByNameRequest.fromPartial({ parentId: PROJECT_ID, name: POLICY_NAME }),
              ),
            'create',
          )
        }
      }
      return undefined
    })
    if (policy === undefined) {
      console.log('  no maxPrice candidate was accepted — the policy half is unanswered this run')
    } else {
      policyId = policy.metadata!.id
      log('D. created', { id: policyId, spec: policyJson(policy)?.spec, status: pricingStatus(policy) })

      // A little settling time: the policy reports STATE_CREATING until ready.
      yield* sleep(10)
      const fetched = yield* pricingPolicies.get(
        PricingPolicyServiceSchema.GetPricingPolicyRequest.fromPartial({ id: policyId }),
      )
      log('D. get', { status: pricingStatus(fetched), spec: policyJson(fetched)?.spec })

      const byName = yield* pricingPolicies.getByName(
        MetadataSchema.GetByNameRequest.fromPartial({ parentId: PROJECT_ID, name: POLICY_NAME }),
      )
      console.log(`D. getByName → ${byName.metadata?.id} (same as create: ${byName.metadata?.id === policyId})`)

      const listed = yield* pricingPolicies.list(
        PricingPolicyServiceSchema.ListPricingPoliciesRequest.fromPartial({ parentId: PROJECT_ID, pageSize: Long.fromNumber(100) }),
      )
      console.log(`D. list → ${listed.items.length} row(s): ${listed.items.map((item) => item.metadata?.name).join(', ')}`)

      // `max_price` is documented as mutable while `running_vm_count` is 0, and the status reports
      // STATE_UPDATING while it lands — both are checkable right here.
      // Run 1 sent `{id, resourceVersion}` and the service answered a bare
      // `3 INVALID_ARGUMENT: Request validation error` — the same missing `parent_id` that made the
      // compute arm's rejection readable ("metadata.parent_id is invalid"). Both variants are tried,
      // because whether an immutable field may be *omitted* on update is provider-#41 groundwork:
      // the full spec first, then the mutable half only.
      const updatePolicy = (label: string, spec: PricingPolicySchema.PricingPolicySpec) =>
        pricingPolicies
          .update(
            PricingPolicyServiceSchema.UpdatePricingPolicyRequest.fromPartial({
              metadata: {
                id: policyId,
                parentId: PROJECT_ID,
                resourceVersion: fetched.metadata!.resourceVersion.toString(),
              },
              spec,
            }),
          )
          .pipe(
            Effect.tap(() => Effect.sync(() => console.log(`  policy update (${label}) ACCEPTED (operation returned)`))),
            Effect.catch((error) =>
              Effect.sync(() => {
                console.log(`  policy update (${label}) REJECTED: ${String(error).slice(0, 300)}`)
                return undefined
              }),
            ),
          )

      const fullSpecUpdate = yield* updatePolicy('full spec, maxPrice 3.000 → 4.000', {
        computeInstanceSpec: { v1: { platform: POLICY_PLATFORM } },
        pricing: { maxPriceV1: { maxPrice: '4.000' } },
      })
      if (fullSpecUpdate !== undefined) {
        const afterUpdate = yield* waitForPolicy(
          () => pricingPolicies.get(PricingPolicyServiceSchema.GetPricingPolicyRequest.fromPartial({ id: policyId! })),
          'update',
        )
        log('D. after the full-spec update', {
          status: afterUpdate === undefined ? null : pricingStatus(afterUpdate),
          spec: policyJson(afterUpdate)?.spec,
        })
      }

      const mutableOnlyUpdate = yield* updatePolicy('pricing only, maxPrice → 2.500', {
        pricing: { maxPriceV1: { maxPrice: '2.500' } },
      })
      if (mutableOnlyUpdate !== undefined) {
        const afterMutable = yield* waitForPolicy(
          () => pricingPolicies.get(PricingPolicyServiceSchema.GetPricingPolicyRequest.fromPartial({ id: policyId! })),
          'mutable-only update',
        )
        log('D. after the pricing-only update (did the immutable platform survive?)', {
          status: afterMutable === undefined ? null : pricingStatus(afterMutable),
          spec: policyJson(afterMutable)?.spec,
        })
      }
    }

    // ── A/B. the `pricing` arms on a real instance ─────────────────────────
    console.log(`\n${'\u2500'.repeat(78)}\n[${stamp()}] A/B. compute/v1 Instance — the pricing arms\n${'\u2500'.repeat(78)}`)
    const template = (over: Record<string, unknown> = {}) => ({
      resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
      bootDisk: {
        attachMode: 'READ_WRITE',
        managedDisk: {
          name: INSTANCE_NAME,
          spec: { type: 'NETWORK_SSD', sizeGibibytes: 64, sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' } },
        },
      },
      networkInterfaces: [{ subnetId: SUBNET_ID, name: 'eth0', ipAddress: { allocationId: '' } }],
      serviceAccountId: SERVICE_ACCOUNT_ID,
      cloudInitUserData: '#cloud-config\n',
      ...over,
    })

    /**
     * An update with the payload this API actually wants.
     *
     * Run 1 sent `{id, resourceVersion}` and got `3 INVALID_ARGUMENT: metadata.parent_id is invalid` —
     * the compute API requires `metadata.parentId` on update (the provider has a comment saying so), so
     * that rejection was the *probe*'s bug, not the provider's.
     */
    const updateInstance = (id: string, over: Record<string, unknown>) =>
      Effect.gen(function* () {
        const live = yield* compute.instance.get(id)
        return yield* compute.instance
          .update({
            metadata: { id, parentId: PROJECT_ID, resourceVersion: live.metadata!.resourceVersion.toString() },
            spec: InstanceSchema.InstanceSpec.fromJSON(template(over)),
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => console.log('  update ACCEPTED'))),
            Effect.catch((error) =>
              Effect.sync(() => {
                console.log(`  update REJECTED: ${String(error).slice(0, 400)}`)
                return undefined
              }),
            ),
          )
      })

    // A. Create pinning NOTHING: if the platform materializes a default arm into `spec`, it shows up
    // here — and that is exactly what the news-side guard in `instanceSpecDrifted` exists for.
    const created = yield* compute.instance
      .create({
        metadata: { parentId: PROJECT_ID, name: INSTANCE_NAME },
        spec: InstanceSchema.InstanceSpec.fromJSON(template()),
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => console.log('  create (no pricing) ACCEPTED'))),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.log(`  create REJECTED: ${String(error).slice(0, 400)}`)
            return undefined
          }),
        ),
      )
    if (created === undefined) return
    instanceId = created.metadata!.id
    log('A. create WITHOUT pricing — is a default arm materialized?', {
      materializedOnDemand: created.spec?.onDemand !== undefined,
      materializedFollowsSpotPrice: created.spec?.followsSpotPrice !== undefined,
      materializedSpotPolicy: created.spec?.spotPricingPolicy !== undefined,
      spec: instanceSpecJson(created.spec),
      resourceVersion: created.metadata?.resourceVersion?.toString(),
    })

    // B. Pin the arm by update — which also re-proves the reshape (a flat `onDemand`, not a `pricing`).
    const pinned = yield* updateInstance(instanceId, { onDemand: {} })
    log('B. after pinning onDemand by update', {
      accepted: pinned !== undefined,
      echoedOnDemand: pinned?.spec?.onDemand !== undefined,
      resourceVersion: pinned?.metadata?.resourceVersion?.toString(),
      spec: instanceSpecJson(pinned?.spec),
    })

    // B2. Omit it again — the question run 1 could not reach: keep (leave unchanged) or clear? The props
    // send nothing for an omitted prop, so this is what a user who deletes the line gets.
    const omitted = yield* updateInstance(instanceId, {})
    log('B2. after an update that OMITTED the arm — kept or cleared?', {
      stillPresent: omitted?.spec?.onDemand !== undefined,
      resourceVersion: omitted?.metadata?.resourceVersion?.toString(),
      spec: instanceSpecJson(omitted?.spec),
    })

    // C. The API's own coupling rule, with a real policy id and a NON-preemptible instance.
    console.log(`\n${'\u2500'.repeat(78)}\n[${stamp()}] C. the coupling rule: spot arm on a NON-preemptible instance\n${'\u2500'.repeat(78)}`)
    if (policyId === undefined) {
      console.log('  skipped — no policy id was obtained')
    } else {
      const withPolicy = yield* updateInstance(instanceId, { spotPricingPolicy: { id: policyId } })
      if (withPolicy !== undefined) {
        console.log('  update ACCEPTED — the API does NOT enforce the documented coupling')
        log('C. spec after the accepted mismatch', { spec: instanceSpecJson(withPolicy.spec) })
      }
    }
  }).pipe(
    Effect.ensuring(

      Effect.gen(function* () {
        if (instanceId !== undefined) {
          yield* compute.instance
            .delete(instanceId)
            .pipe(
              Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] cleanup — instance deleted: ${instanceId}`))),
              Effect.catch((error) =>
                Effect.sync(() => console.error(`cleanup FAILED — delete the instance by hand: ${instanceId}: ${String(error)}`)),
              ),
            )
        }
        // The policy goes second: a policy with a running VM refuses deletion.
        if (policyId !== undefined) {
          yield* pricingPolicies
            .delete(PricingPolicyServiceSchema.DeletePricingPolicyRequest.fromPartial({ id: policyId }))
            .pipe(
              Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] cleanup — pricing policy deleted: ${policyId}`))),
              Effect.catch((error) =>
                Effect.sync(() => console.error(`cleanup FAILED — delete the policy by hand: ${policyId}: ${String(error)}`)),
              ),
            )
        }
      }),
    ),
  )

  // ── Postflight ────────────────────────────────────────────────────────────
  yield* sleep(10)
  const [instancesAfter, policiesAfter] = yield* Effect.all([
    instanceWitness(compute),
    pricingPolicies
      .list(
        PricingPolicyServiceSchema.ListPricingPoliciesRequest.fromPartial({
          parentId: PROJECT_ID,
          pageSize: Long.fromNumber(100),
        }),
      )
      .pipe(Effect.map((response) => response.items.map((policy) => policy.metadata?.name ?? '?'))),
  ])
  log('POSTFLIGHT', { instances: instancesAfter, pricingPolicies: policiesAfter })
  if (instancesAfter.length > 0 || policiesAfter.length > 0) console.error('LEAK — clean up by hand.')
})

const transportLayer = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)
const servicesLayer = Layer.mergeAll(
  ComputeGrpcServiceLive,
  IamGrpcServiceLive,
  VpcGrpcServiceLive,
  // The program also reaches `billing/v1 PricingPolicyService` through the raw client
  // (`GrpcUtils.makeGrpcService`), which requires the transport directly — so the transport is
  // provided to the program as well as into the service layers above.
  transportLayer,
).pipe(Layer.provide(transportLayer))

try {
  await Effect.runPromise(program.pipe(Effect.provide(servicesLayer), Effect.scoped))
  console.log(`\n[${stamp()}] PROBE DONE`)
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
