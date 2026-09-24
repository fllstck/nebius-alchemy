/**
 * The published workaround, measured: **can pricing be changed on a stopped instance?**
 *
 * `spikes/compute-pricing-probe.ts` (run 2) established that *introducing* a pricing arm on a **running**
 * instance is refused:
 *
 *   9 FAILED_PRECONDITION: spec fields [pricing_model] update could be done with stopped instance
 *
 * and from that message I inferred the workaround — "stop the instance first, then change it" — and wrote it
 * into the CHANGELOG's upgrade notes, the README, the `pricing` prop's doc comment and `examples/spot-pricing.ts`.
 * The inference is the weak part: what was measured is the *refusal*, not that stopping makes the change
 * land. This closes it, on a CPU instance (cheap, no GPU): `onDemand` is the only legal arm on a
 * non-preemptible VM, so "introduce `onDemand`" is exactly the transition that was refused while running.
 *
 *   A. create **without** pricing             → the spec echoes no pricing field
 *   B. stop it (`stopped: true`)              → accepted, and it must actually reach STOPPED
 *   C. introduce `pricing: { onDemand: true }`→ **the claim**: accepted and echoed while stopped?
 *   D. start it again (`stopped: false`)      → the arm survives a restart?
 *
 * Teardown is `Effect.ensuring` + a postflight listing.
 *
 *   bun spikes/compute-pricing-stopped-change-probe.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
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
const INSTANCE_NAME = 'alchemy-pricing-stopped-change'

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

const facts = (instance: InstanceSchema.Instance) => ({
  onDemand: instance.spec?.onDemand === undefined ? '(absent)' : '{}',
  followsSpotPrice: instance.spec?.followsSpotPrice === undefined ? '(absent)' : '{}',
  spotPricingPolicy: instance.spec?.spotPricingPolicy?.id ?? '(absent)',
  stopped: instance.spec?.stopped ?? false,
  state: instance.status?.state,
  resourceVersion: instance.metadata?.resourceVersion?.toString(),
})

const program = Effect.gen(function* () {
  const compute = yield* ComputeGrpcService
  const iam = yield* IamGrpcService
  const vpc = yield* VpcGrpcService

  const existing = yield* compute.instance.list(PROJECT_ID)
  if (existing.length > 0) {
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

  /** The full spec we resend on every update (compute has no FieldMask, so each update carries all of it). */
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
    // ── A. create without pricing ───────────────────────────────────────────
    let instance = yield* compute.instance.create({
      metadata: { parentId: PROJECT_ID, name: INSTANCE_NAME },
      spec: InstanceSchema.InstanceSpec.fromJSON(template()),
    })
    instanceId = instance.metadata!.id
    log('A. created WITHOUT pricing', facts(instance))

    /** An update with the payload compute wants: fresh `resourceVersion` + `metadata.parentId`. */
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
        log(label, facts(after))
        return { accepted: updated !== undefined, after }
      })

    /** Wait until the platform reports the state we just asked for (a stop/start is an operation). */
    const waitForState = (want: string, limitSeconds = 180) =>
      Effect.gen(function* () {
        const until = Date.now() + limitSeconds * 1000
        for (;;) {
          const live = yield* compute.instance.get(instanceId!)
          const state = live.status?.state
          if (String(state) === want) return live
          if (Date.now() > until) {
            console.log(`  (waitForState) still ${String(state)} after ${limitSeconds}s — carrying on`)
            return live
          }
          yield* sleep(10)
        }
      })

    // ── B. stop it ──────────────────────────────────────────────────────────
    yield* update('B. stop it (stopped: true, no pricing)', { stopped: true })
    const stopped = yield* waitForState('STOPPED')
    console.log(`  state after the stop: ${String(stopped.status?.state)}`)

    // ── C. THE CLAIM: introduce the arm while stopped ───────────────────────
    // The same transition that was refused on a running instance.
    const introduced = yield* update('C. introduce pricing { onDemand: true } while STOPPED', {
      stopped: true,
      onDemand: {},
    })
    log('C. verdict — did the published workaround hold?', {
      accepted: introduced.accepted,
      armInSpec: introduced.after.spec?.onDemand !== undefined,
      note: 'accepted + armInSpec = the CHANGELOG/README/prop-doc/example claim is measured; otherwise those need correcting',
    })

    // ── D. start it again, arm kept ─────────────────────────────────────────
    const restarted = yield* update('D. start again (stopped: false), arm kept', { onDemand: {} })
    const running = yield* waitForState('RUNNING')
    log('D. after the restart', { ...facts(running), restartedAccepted: restarted.accepted })
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (instanceId === undefined) return
        yield* compute.instance
          .delete(instanceId)
          .pipe(
            Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] cleanup — instance deleted: ${instanceId}`))),
            Effect.catch((error) =>
              Effect.gen(function* () {
                console.log(`  first delete failed (${String(error).slice(0, 160)}); retrying after 20 s`)
                yield* sleep(20)
                yield* compute.instance.delete(instanceId!).pipe(
                  Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] cleanup — deleted on retry: ${instanceId}`))),
                  Effect.catch((retryError) =>
                    Effect.sync(() => console.error(`cleanup FAILED — delete by hand: ${instanceId}: ${String(retryError)}`)),
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
  log('POSTFLIGHT', { instances: after.map((entry) => entry.metadata?.name) })
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
