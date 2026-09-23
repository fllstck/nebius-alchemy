/**
 * `compute/v1 Instance.pricing` — the immutability rule, and what a pinned arm does to later updates.
 *
 * `spikes/compute-pricing-probe.ts` (run 2) found that an update *introducing* a pricing arm on a running
 * instance is refused:
 *
 *   9 FAILED_PRECONDITION: spec fields [pricing_model] update could be done with stopped instance
 *
 * That is not just a note for the prop: `reconcile` sends the **full desired spec** whenever *any* drift
 * is detected, so if the API refuses the field's mere presence in an update, then **pinning `pricing`
 * would make every later in-place update of that instance fail** — for an unrelated reason, with an error
 * that names pricing. That is the difference between "a doc note" and "a planned replace", so it is
 * measured here rather than reasoned about:
 *
 *   D2a. create with `onDemand` pinned (+ a `hostname`, so there is something harmless to change)
 *   D2b. update **another** field while still sending the same arm — accepted, or refused?
 *   D2c. stop it (`stopped: true`, the provider's own prop) and update the arm while stopped
 *   D2d. with it stopped, drop the arm — i.e. the workaround a user has to perform by hand
 *
 * One 2-vCPU instance, minutes. `bun spikes/compute-pricing-stopped-probe.ts`
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
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as IamGrpcModule from '../modules/api-client/iam.ts'
import * as VpcGrpcModule from '../modules/api-client/vpc.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import * as InstanceSchema from '../schemas/nebius/compute/v1/instance.ts'

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
const INSTANCE_NAME = 'alchemy-pricing-stopped-probe'

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

const specFacts = (spec: InstanceSchema.InstanceSpec | undefined) => ({
  onDemand: spec?.onDemand === undefined ? '(absent)' : '{}',
  followsSpotPrice: spec?.followsSpotPrice === undefined ? '(absent)' : '{}',
  spotPricingPolicy: spec?.spotPricingPolicy === undefined ? '(absent)' : spec.spotPricingPolicy.id,
  hostname: spec?.hostname ?? '(absent)',
  stopped: spec?.stopped ?? false,
})

const program = Effect.gen(function* () {
  const compute = yield* ComputeGrpcService
  const iam = yield* IamGrpcService
  const vpc = yield* VpcGrpcService

  const instances = yield* compute.instance.list(PROJECT_ID)
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

  let instanceId: string | undefined

  yield* Effect.gen(function* () {
    // ── D2a: create WITH the arm pinned ─────────────────────────────────────
    const created = yield* compute.instance
      .create({
        metadata: { parentId: PROJECT_ID, name: INSTANCE_NAME },
        spec: InstanceSchema.InstanceSpec.fromJSON(template({ onDemand: {}, hostname: 'probe-a' })),
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => console.log('  create (onDemand pinned) ACCEPTED'))),
        Effect.catch((error) =>
          Effect.sync(() => {
            console.log(`  create REJECTED: ${String(error).slice(0, 400)}`)
            return undefined
          }),
        ),
      )
    if (created === undefined) return
    instanceId = created.metadata!.id
    log('D2a. created with the arm pinned', {
      spec: specFacts(created.spec),
      resourceVersion: created.metadata?.resourceVersion?.toString(),
    })

    /** An update carrying the full desired spec — what `reconcile` sends on any drift. */
    const update = (label: string, over: Record<string, unknown>) =>
      Effect.gen(function* () {
        const live = yield* compute.instance.get(instanceId!)
        const updated = yield* compute.instance
          .update({
            metadata: { id: instanceId!, parentId: PROJECT_ID, resourceVersion: live.metadata!.resourceVersion.toString() },
            spec: InstanceSchema.InstanceSpec.fromJSON(template(over)),
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => console.log(`  ${label}: ACCEPTED`))),
            Effect.catch((error) =>
              Effect.sync(() => {
                console.log(`  ${label}: REJECTED: ${String(error).slice(0, 400)}`)
                return undefined
              }),
            ),
          )
        const after = updated ?? (yield* compute.instance.get(instanceId!))
        log(label, { spec: specFacts(after.spec), resourceVersion: after.metadata?.resourceVersion?.toString() })
        return updated !== undefined
      })

    // ── D2b: change an unrelated field, still sending the same arm ──────────
    // This is the footgun question: if this is refused, pinning `pricing` breaks *every* later update.
    yield* update('D2b. update hostname a → b, pricing arm KEPT', { onDemand: {}, hostname: 'probe-b' })

    // ── D2c: stop it (the provider's own `stopped` prop), arm still kept ────
    yield* update('D2c. stop it (stopped: true), arm KEPT', { onDemand: {}, hostname: 'probe-b', stopped: true })
    yield* sleep(20)

    // ── D2d: with it stopped, drop the arm (the manual workaround) ──────────
    yield* update('D2d. while STOPPED, drop the arm', { hostname: 'probe-b', stopped: true })
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (instanceId === undefined) return
        // A stopped instance deletes like any other; retry once, since a stale resourceVersion or an
        // in-flight state transition is possible right after the stop.
        yield* compute.instance
          .delete(instanceId)
          .pipe(
            Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] cleanup — instance deleted: ${instanceId}`))),
            Effect.catch((error) =>
              Effect.gen(function* () {
                console.log(`  first delete failed (${String(error).slice(0, 160)}); retrying after 20 s`)
                yield* sleep(20)
                yield* compute.instance.delete(instanceId!).pipe(
                  Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] cleanup — instance deleted on retry: ${instanceId}`))),
                  Effect.catch((retryError) =>
                    Effect.sync(() =>
                      console.error(`cleanup FAILED — delete by hand: ${instanceId}: ${String(retryError)}`),
                    ),
                  ),
                )
              }),
            ),
          )
      }),
    ),
  )

  yield* sleep(10)
  const after = yield* compute.instance.list(PROJECT_ID)
  log('POSTFLIGHT', { instances: after.map((instance) => instance.metadata?.name) })
  if (after.length > 0) console.error('LEAK — clean up by hand.')
})

const transportLayer = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)
const servicesLayer = Layer.mergeAll(ComputeGrpcServiceLive, IamGrpcServiceLive, VpcGrpcServiceLive).pipe(
  Layer.provide(transportLayer),
)

try {
  await Effect.runPromise(program.pipe(Effect.provide(servicesLayer), Effect.scoped))
  console.log(`\n[${stamp()}] PROBE DONE`)
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
