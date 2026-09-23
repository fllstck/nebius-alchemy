import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyServer from 'alchemy/Server'

import * as NebiusInstanceSchema from '../../../../schemas/nebius/compute/v1/instance.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ComputeGrpc from '../../../api-client/compute.ts'
import * as GrpcUtils from '../../../api-client/grpc-utils.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as InstanceSchema from './instance.schema.ts'
import * as Factory from '../../factory.ts'
import { tryPromiseRaw } from '../../../effect-utils.ts'

/**
 * Raised when a hosted instance would ship an UNWRAPPED bundle — `main` set
 * without an inline init Effect.
 *
 * `Platform` marks any resource declared without an impl as `isExternal`, and
 * `bundleProgram` skips the Nebius bootstrap virtual entry for external entries,
 * so nothing ever runs `RuntimeContext.exports.program` (no `fetch`, no `serve`,
 * no `host.run` loops): the VM boots and serves nothing, with no error anywhere in
 * the deploy output. Verified by hand (TASKS.md §D8).
 *
 * A self-serving entry is legitimate — pass `isExternal: true` yourself to opt in.
 */
export class HostedEntryNotWrapped extends Schema.TaggedError<HostedEntryNotWrapped>()(
  'HostedEntryNotWrapped',
  {
    id: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Plan/deploy guard for the footgun above: reject `main` + implicit `isExternal`.
 *
 * `exports` is the discriminator for "an inline init Effect ran": `Platform`
 * folds it onto props only inside the SelfLayer (the impl-carrying path), and the
 * props schema does NOT include it — so callers must read it before
 * `validateInstanceProps` strips it. The `hosted.externalOptIn` flag comes from
 * `transformInstanceProps`, which is the only place that sees the user's props
 * BEFORE `Platform` adds `isExternal` itself.
 *
 * WHERE IT CAN FIRE: `reconcile` (any deploy — before the first API call, so a
 * greenfield `alchemy deploy` fails immediately and creates nothing) and `diff`
 * (so a re-plan fails during planning). It CANNOT fail a greenfield
 * `alchemy plan`: alchemy only calls `diff` for resources that already have state
 * (`Plan.ts`), and `precreate`/`onCreate` run too early to know whether an inline
 * impl exists. Exported for tests.
 */
export const assertHostedEntryIsRunnable = Effect.fn('Nebius.compute.v1.Instance.assertHostedEntryIsRunnable')( 
  function* (
    id: string,
    // `unknown`: reconcile has resolved props, diff has `Input<Props>` (Outputs).
    news: unknown,
    hasInlineImpl: boolean,
  ): Effect.fn.Return<void, HostedEntryNotWrapped> {
    const raw = (news ?? {}) as Record<string, unknown>
    if (raw.main === undefined || raw.isExternal !== true || hasInlineImpl) return
    const hosted = raw.hosted as { externalOptIn?: boolean } | undefined
    if (hosted?.externalOptIn === true) return
    return yield* new HostedEntryNotWrapped({
      id,
      message:
        `Nebius.compute.v1.Instance '${id}' sets 'main' without an inline init Effect, so the ` +
        `bundle would ship UNWRAPPED and the VM would boot serving nothing (no 'fetch'/'serve' ` +
        `is ever registered). Declare it as Nebius.compute.Instance(id, props, Effect.gen(function* () { ...; ` +
        `return { fetch } })) — or, if 'main' IS your runnable entry (it starts its own HTTP server), ` +
        `pass 'isExternal: true' explicitly to opt in.`,
    })
  },
)

/**
 * D8: `hosted.ts` is the deploy-side half of the hosted runtime (rolldown
 * bundling via `alchemy/Bundle`, the IAM api-client + proto schemas for the
 * composed identity, the S3 client for artifact upload). Loading it through a
 * DYNAMIC import — only on the unfolded (plan/deploy) side of the runtime guard —
 * is what keeps that whole graph out of a bundled program.
 *
 * A static `import * as Hosted` is NOT enough: `transformProps` is handed to
 * `Alchemy.Platform` at module scope, so the reference survives the provider
 * fold and keeps `hosted.ts` (and therefore rolldown/vite/postcss, the gRPC
 * api-clients and the IAM/proto schemas) in the bundle. Measured on a minimal
 * hosted instance: entry 1917.9 KB → 160.6 KB, `grpc-js` 68 → 0, IAM
 * `AccessPermit` schemas 97 → 0 (TASKS.md §D8).
 */
const loadHosted = () => Effect.promise(() => import('./hosted.ts'))

// ----- RESOURCE TYPES

/**
 * The bind contract an instance exposes to capability bindings (the alchemy
 * `{ env, policyStatements }` shape — EC2 precedent). `env` flows into the
 * shipped env file; `policyStatements` stays empty — Nebius authorizes via
 * IAM AccessPermits, not inline policies.
 */
export interface NebiusInstanceBinding {
  env?: Record<string, unknown>
  policyStatements?: never[]
}

export type NebiusInstance = Alchemy.Resource<
  'Nebius.compute.v1.Instance',
  InstanceSchema.InstanceProps,
  InstanceSchema.InstanceAttributes,
  NebiusInstanceBinding,
  // Provider requirement: mirror the pre-Platform constructor (Req = Provider<R>),
  // so `yield* Instance(...)` inside a stack keeps its provider requirement
  // (discharged by `Nebius.providers()`) instead of collapsing to `undefined`.
  AlchemyProvider.Provider<NebiusInstance>
>

/**
 * Services the bundled hosted program (the `impl` passed to the constructor
 * alongside `main`) may require.
 *
 * - `ServerHost` — `host.run`/`serve` loops; wired automatically by `Platform`
 *   for host runtime contexts.
 * - `Stack` / `Stage` — provided in the bundle bootstrap from the shipped
 *   `ALCHEMY_STACK_NAME` / `ALCHEMY_STAGE` env (mirrors the AWS EC2 bootstrap).
 *
 * Nebius API config/credentials are deliberately NOT platform services: the
 * deploy-side `NebiusCredentials` service resolves via `AlchemyProfile`/auth
 * providers that don't exist on the VM. Bundled code reads Nebius config from
 * the shipped env file (region, project, keys) through the
 * `reifyBoundConfigProvider` interceptor — `Config.String('NEBIUS_REGION')`
 * etc. — and calls Nebius APIs via typed bindings (Task 5).
 */
export type NebiusInstanceServices = AlchemyServer.ServerHost | Alchemy.Stack | Alchemy.Stage

export type NebiusInstanceShape = Alchemy.Main<NebiusInstanceServices>

export type NebiusInstanceRuntimeContext = AlchemyServer.HostRuntimeContext

/**
 * Nebius.compute.v1.Instance — ONE resource, two modes: `main` omitted =
 * low-level primitive (plain CRUD); `main` set = hosted runtime that bundles
 * the Effect program and runs it on the machine (Effectful Constructor
 * pattern, mirroring `AWS.EC2.Instance`).
 */
export const NebiusInstance: Alchemy.Platform<
  NebiusInstance,
  NebiusInstanceServices,
  NebiusInstanceShape,
  NebiusInstanceRuntimeContext
> = Alchemy.Platform('Nebius.compute.v1.Instance', {
  createRuntimeContext: AlchemyServer.createHostRuntimeContext('Nebius.compute.v1.Instance'),
  // Compose the hosted-mode identity (assets bucket + fetch key + grants) as
  // REAL child resources at plan time when `main` is set. No-op for low-level
  // instances and inside deployed bundles (see hosted.transformInstanceProps).
  transformProps: (id, props) =>
    globalThis.__ALCHEMY_RUNTIME__
      ? Effect.succeed(props)
      : Effect.flatMap(loadHosted(), (Hosted) => Hosted.transformInstanceProps(id, props)),
})

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusInstanceSchema.Instance} (metadata + spec + status)
 * into {@link InstanceSchema.InstanceAttributes}.
 *
 * Hosted-mode attrs (`runtimeUnitName`, `assetPrefix`, `code.hash`, and the
 * internal `hosted*` cleanup state) are provider state, not protobuf fields —
 * threaded via `hostedOverrides` (the same way AWS EC2 returns
 * `roleArn`/`assetPrefix` from provider state).
 */
const toFriendlyAttributes = (
  rawInstance: NebiusInstanceSchema.Instance,
  hostedOverrides: Partial<
    Pick<
      InstanceSchema.InstanceAttributes,
      | 'runtimeUnitName'
      | 'assetPrefix'
      | 'code'
      | 'hostedBucketName'
      | 'hostedRegion'
      | 'hostedAccessKeyId'
      | 'hostedSecretAccessKey'
    >
  > = {},
): InstanceSchema.InstanceAttributes =>
  ResourceUtils.toFriendlyAttributes<InstanceSchema.InstanceAttributes>({
    rawResource: rawInstance,
    resourceSchema: NebiusInstanceSchema.Instance,
    overrides: hostedOverrides,
  })

// ----- HOSTED-RUNTIME HELPERS

/** Platform-level hosted props — stripped before `InstanceSpec.fromJSON`. */
const HOSTED_SPEC_KEYS = new Set(['main', 'handler', 'port', 'env', 'build', 'isExternal', 'bucket', 'hosted', 'exports'])

/**
 * The spec INPUT: the user's props minus the hosted props, with the merged
 * cloud-init user-data (generated bootstrap first, user's after) injected.
 * Exported for unit tests (spec-stripping invariant).
 */
export const hostedSpecInput = (news: InstanceSchema.InstanceProps, userData: string | undefined): Record<string, unknown> => {
  const spec: Record<string, unknown> = { ...news }
  for (const key of HOSTED_SPEC_KEYS) delete spec[key]
  // The `pricing` prop is a **deliberate reshape of a flat oneof** (see `PricingModelSchema`): the wire has
  // three siblings on `InstanceSpec` and no `pricing` message, so passing the prop through would be dropped
  // **silently** by `fromJSON` — the `transfer.stopCondition` trap. Spread the arms onto the flat fields
  // instead (nothing at all when the prop is omitted, which is the platform's default).
  delete spec.pricing
  Object.assign(spec, ResourceUtils.pricingModelFields(news.pricing))
  if (userData !== undefined) spec.cloudInitUserData = userData
  return spec
}

/**
 * `InstanceSpec.gpuCluster` is create-only in the proto ("GPU cluster ID for
 * InfiniBand interconnect. Only settable at creation"), so a change in either
 * direction is a REPLACE — which is also why the field is deliberately absent
 * from `reconcile`'s drift list below: an update there would ask the API to do
 * the one thing it cannot.
 *
 * Unlike the house "guarded on the news side" rule for in-place spec fields,
 * this compares BOTH sides: adding the cluster to or dropping it from an
 * existing instance is the same transition. The caller decides the ordering
 * (`Factory.replaceKeepingName`) because that depends on the name, not on this
 * field.
 */
const gpuClusterChanged = (news: { gpuCluster?: { id?: string } }, olds?: { gpuCluster?: { id?: string } }): boolean =>
  (news.gpuCluster?.id ?? '') !== (olds?.gpuCluster?.id ?? '')

/**
 * Whether a **pinned** pricing arm differs from the live spec.
 *
 * The wire is flat — `InstanceSpec` carries `onDemand`/`followsSpotPrice`/`spotPricingPolicy` as
 * siblings, not a `pricing` message — so this compares the arms the caller pinned against the matching
 * live fields, one by one. An empty wire message decodes as `{}`, which is what a pinned `true` maps to
 * (`ResourceUtils.pricingModelFields`), so "the arm is already set" and "the spec says nothing" stay
 * distinguishable. Switching arms therefore reads as drift (the new arm is absent live), while leaving
 * `pricing` out of the props compares nothing at all — and that guard is load-bearing for a *measured*
 * reason: an update that omits the arm leaves it in place, so an unconditional comparison would ask the
 * API to clear something it never clears, on every reconcile.
 */
const pricingDrifted = (
  live: NebiusInstanceSchema.InstanceSpec | undefined,
  pricing: NonNullable<InstanceSchema.InstanceProps['pricing']>,
): boolean =>
  (pricing.onDemand !== undefined && !ResourceUtils.specDeepEqual(live?.onDemand, {})) ||
  (pricing.followsSpotPrice !== undefined && !ResourceUtils.specDeepEqual(live?.followsSpotPrice, {})) ||
  (pricing.spotPricingPolicy !== undefined &&
    !ResourceUtils.specDeepEqual(live?.spotPricingPolicy, { id: pricing.spotPricingPolicy.id }))

/**
 * Which spec fields an in-place update converges.
 *
 * The engine plans an `action: "update"` for **any** props change a `diff`
 * ignores (`Plan.ts`: `diff ?? { action: havePropsChanged(olds, news) ? "update" : "noop" }`),
 * so a field missing from this list is a change that plans an update and then
 * writes nothing — exactly how `gpuCluster` behaved before it was fixed. Search
 * that guard: this list IS the convergence contract for the Instance.
 *
 * Deliberately absent: `gpuCluster` (create-only → the diff replaces) and
 * `preemptible` (cannot be toggled → the diff replaces).
 *
 * `pricing` is present but **news-guarded** — the flat `pricing_model` arms are compared only when the
 * caller pinned one, because the platform's materialization and in-place-mutability behaviour for them is
 * unmeasured (see `pricingDrifted`).
 *
 * Exported for unit tests. The "guarded on the news side" entries exist because
 * the platform may answer an omitted optional message with a default —
 * enforcing them unconditionally would loop updates.
 */
export const instanceSpecDrifted = (
  live: NebiusInstanceSchema.Instance['spec'],
  desired: NebiusInstanceSchema.InstanceSpec,
  news: InstanceSchema.InstanceProps,
): boolean => {
  if (!live) return false
  return (
    !ResourceUtils.specDeepEqual(live.resources, desired.resources) ||
    !ResourceUtils.specDeepEqual(live.bootDisk, desired.bootDisk) ||
    !ResourceUtils.specDeepEqual(live.networkInterfaces, desired.networkInterfaces) ||
    !ResourceUtils.specDeepEqual(live.secondaryDisks, desired.secondaryDisks) ||
    !ResourceUtils.specDeepEqual(live.filesystems, desired.filesystems) ||
    live.nvlInstanceGroupId !== desired.nvlInstanceGroupId ||
    (news.localDisks !== undefined && !ResourceUtils.specDeepEqual(live.localDisks, desired.localDisks)) ||
    (news.reservationPolicy !== undefined &&
      !ResourceUtils.specDeepEqual(live.reservationPolicy, desired.reservationPolicy)) ||
    !ResourceUtils.specDeepEqual(live.serviceAccountId, desired.serviceAccountId) ||
    live.cloudInitUserData !== desired.cloudInitUserData ||
    live.stopped !== desired.stopped ||
    live.recoveryPolicy !== desired.recoveryPolicy ||
    live.hostname !== desired.hostname ||
    // Guarded on the news side, and the measurement is why (live 2026-09-24): an update that *omits* the
    // arm leaves it in place (absent means "leave unchanged", never "clear"), a create that pins nothing
    // materializes no arm at all, and repeating a pinned arm in an update is accepted while *changing* it
    // on a running instance is refused (`9 FAILED_PRECONDITION: spec fields [pricing_model] update could
    // be done with stopped instance`). Comparing only a pinned arm keeps all three a non-event here; the
    // API's refusal is an apply-time error the prop documents, not something this list can fix.
    (news.pricing !== undefined && pricingDrifted(live, news.pricing))
  )
}

/** Map the protobuf instance-state enum to its friendly name. */
const friendlyState = (state: unknown): string => {
  if (typeof state === 'number') return NebiusInstanceSchema.instanceStatus_InstanceStateToJSON(state)
  if (typeof state === 'string') return state
  return 'UNSPECIFIED'
}

/**
 * Poll the instance until it reaches one of `targetStates` (or fails).
 * Emits `session.note` progress on every state transition.
 */
/**
 * D8: the `@__PURE__` annotation keeps this deploy-only helper droppable. It is
 * declared at MODULE scope (its signature names the gRPC service) but only
 * called from inside the guarded provider; without the annotation the retained
 * `Effect.fn(...)(...)` call drags the whole gRPC/api-client graph into runtime
 * bundles (measured: 100 `grpc-js` sites in the instance bundle). See TASKS.md
 * §D8.
 */
const waitForInstanceState = /* @__PURE__ */ Effect.fn('waitForInstanceState')(function* ({
  instanceId,
  targetStates,
  session,
}: {
  instanceId: string
  targetStates: Array<string>
  session: { note(message: string): Effect.Effect<void> }
}): Effect.fn.Return<
  string,
  GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError,
  ComputeGrpc.ComputeGrpcService
> {
  const computeGrpcService = yield* ComputeGrpc.ComputeGrpcService
  const deadline = Date.now() + 15 * 60 * 1000
  let last: string | undefined
  while (Date.now() < deadline) {
    const current = yield* computeGrpcService.instance.get(instanceId)
    const state = friendlyState(current.status?.state)
    if (state !== last) {
      if (last !== undefined) yield* session.note(`Nebius.compute.v1.Instance state → ${state}`)
      last = state
    }
    if (targetStates.includes(state)) return state
    if (state === 'ERROR' || state === 'DELETING') {
      return yield* Effect.die(
        new Error(`Nebius.compute.v1.Instance (${instanceId}) entered ${state} state — aborting`),
      )
    }
    yield* Effect.sleep('5 seconds')
  }
  return yield* Effect.die(
    new Error(
      `Nebius.compute.v1.Instance (${instanceId}) did not reach ${targetStates.join('/')} within 15 minutes`,
    ),
  )
})

/**
 * Best-effort read-back of the VM's running bundle hash (Deviation 1's
 * "divergence → restart again" half). The fetch script's `ExecStartPre` must
 * SUCCEED before bun runs the entry, so a reachable HTTP port ⟹ the running
 * code is the shipped manifest hash.
 *
 * - no public IP → assume converged (cannot probe; `Restart=always` is the
 *   backstop)
 * - probe answers → the shipped hash is running
 * - probe stays silent (bounded ~2 min window) → keep the PREVIOUS hash so
 *   the next reconcile sees divergence and restarts again
 */
const readBackRunningHash = Effect.fn('readBackRunningHash')(function* ({
  instance,
  port,
  shippedHash,
  previousHash,
  session,
}: {
  instance: NebiusInstanceSchema.Instance
  port: number
  shippedHash: string | undefined
  previousHash: string | undefined
  session: { note(message: string): Effect.Effect<void> }
}): Effect.fn.Return<string | undefined> {
  const publicIp = instance.status?.networkInterfaces
    ?.map((networkInterface) => networkInterface.publicIpAddress?.address?.split('/')[0])
    .find((address) => address)
  if (!publicIp || shippedHash === undefined) return shippedHash

  // `tryPromiseRaw`: the failure is only used as a boolean below, but keeping
  // the raw rejection means a future retry/classification here still works.
  const probeUp = tryPromiseRaw(() =>
    fetch(`http://${publicIp}:${port}/`, { signal: AbortSignal.timeout(5_000) }),
  )
  const up = yield* probeUp.pipe(
    Effect.retry({ times: 24, schedule: Schedule.spaced('5 seconds') }),
    Effect.matchEffect({
      onFailure: () => Effect.succeed(false),
      onSuccess: () => Effect.succeed(true),
    }),
  )
  if (!up) {
    yield* session.note(
      `Hosted process on ${publicIp}:${port} not reachable — keeping previous bundle hash (restart on next deploy)`,
    )
    return previousHash
  }
  return shippedHash
})

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusInstanceProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusInstance>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusInstance>, never, any>)
  : AlchemyProvider.succeed(NebiusInstance, {
  // Observe → Ensure → Sync → Restart-if-code-changed → Wait → Return
  reconcile: Effect.fn('Nebius.compute.v1.Instance.reconcile')(function* ({ id, news, olds, output, bindings, session }) {
    news = news || {}

    // `exports` is stripped by validation below (it is not a schema field).
    yield* assertHostedEntryIsRunnable(id, news, (news as Record<string, unknown>).exports !== undefined)

    // Validate user input at runtime
    news = yield* InstanceSchema.validateInstanceProps(news)

    const computeGrpcService = yield* ComputeGrpc.ComputeGrpcService

    // Host mode: bundle → ship → resolve the runtime (user-data + state).
    // Low-level mode: passthrough (runtime.userData = the user's cloud-init).
    const runtime = yield* (yield* loadHosted()).resolveHostedRuntime({ id, news, bindings, output })

    // Strip hosted props (platform-level, never InstanceSpec fields) and
    // inject the merged cloud-init user-data (bootstrap first, user's after).
    const specNews = hostedSpecInput(news, runtime.userData)
    const desired = NebiusInstanceSchema.InstanceSpec.fromJSON(specNews)

    // 1. Observe — fetch live state if we have a cached physical ID
    let instance: NebiusInstanceSchema.Instance | undefined
    if (output?.id) {
      instance = yield* computeGrpcService.instance
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
    // The merged labels are computed **once** and sent on every update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change means
    // carrying the full intended set each time — and a label removed from config is then removed in the
    // cloud (measured 2026-09-24 on `vpc/v1 Network`, `spikes/labels-convergence-probe.ts`; AGENTS.md
    // §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!instance) {
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      yield* session.note(`Creating Nebius.compute.v1.Instance (${name})`)
      instance = yield* computeGrpcService.instance
        .create({
          metadata: { parentId, name, labels },
          spec: desired,
        })
        .pipe(
          // Create can time out client-side while the backend still starts the
          // instance (the long-running operation is created server-side before
          // the response reaches us). Recover by looking the instance up by its
          // deterministic physical name and adopting it — otherwise destroy has
          // no ID to act on and silently leaks a running VM + boot disk.
          Effect.catch((e: unknown) =>
            Effect.gen(function* () {
              const recovered = yield* computeGrpcService.instance
                .getByName({ parentId, name })
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (recovered) {
                yield* session.note(
                  `Recovered Nebius.compute.v1.Instance (${recovered.metadata!.id}) after create failure`,
                )
                return recovered
              }
              return yield* Effect.fail(e)
            }),
          ),
        )
    }

    const instanceId = instance.metadata!.id
    const desiredStopped = Boolean(specNews.stopped)

    // 3. Sync — update if the spec drifted from desired (hosted merges the
    //    generated bootstrap into cloudInitUserData; user-data change = update,
    //    Deviation 2 — Nebius accepts it in place).
    //
    //    `gpuCluster` is absent from the list below BY DESIGN: it is create-only,
    //    so a difference is a `replace` (see `gpuClusterChangeRequiresReplace`),
    //    never an in-place update — the API rejects an update that tries.
    if (
      instanceSpecDrifted(instance.spec, desired, news) ||
      // A labels-only change is not a spec drift, so it needs its own trigger — carrying the merged map in
      // `metadata.labels` converges only if this condition fires (`Factory.labelsDrifted`).
      Factory.labelsDrifted(instance.metadata?.labels, news.labels, olds?.labels)
    ) {
      yield* session.note(`Updating Nebius.compute.v1.Instance (${instance.metadata!.name})`)
      // The compute API requires metadata.parentId on update (unlike VPC
      // resources) — omitting it yields `INVALID_ARGUMENT: ParentID is invalid`.
      instance = yield* computeGrpcService.instance.update({
        metadata: {
          id: instanceId,
          parentId,
          resourceVersion: instance.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: desired,
      })
    }

    // 4. Host-mode restart — ONLY when the shipped bundle hash differs from
    //    what the VM is running (Deviation 1: no reboot API; stop→start via
    //    the `stopped` spec flag). The unit's unconditional `ExecStartPre`
    //    re-fetches the manifest on start, so the restart converges the code.
    //    Crash-restarts self-heal via `Restart=always` + the same re-fetch.
    const needsRestart =
      Boolean(news.main) &&
      !desiredStopped &&
      output?.code?.hash !== undefined &&
      runtime.code?.hash !== undefined &&
      output.code.hash !== runtime.code.hash
    if (needsRestart) {
      yield* session.note(`Restarting Nebius.compute.v1.Instance (${instance.metadata!.name}) to pick up new bundle`)
      const stoppedSpec = NebiusInstanceSchema.InstanceSpec.fromJSON({ ...specNews, stopped: true })
      instance = yield* computeGrpcService.instance.update({
        metadata: {
          id: instanceId,
          parentId,
          resourceVersion: instance.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: stoppedSpec,
      })
      yield* waitForInstanceState({ instanceId, targetStates: ['STOPPED'], session })
      const stopped = yield* computeGrpcService.instance.get(instanceId)
      instance = yield* computeGrpcService.instance.update({
        metadata: {
          id: instanceId,
          parentId,
          resourceVersion: stopped.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: desired,
      })
    }

    // 5. Wait for a terminal state — on create AND on observed transient
    //    states (CREATING/STARTING/UPDATING — a previous deploy may have
    //    crashed mid-provisioning).
    const target = desiredStopped ? ['STOPPED'] : ['RUNNING']
    yield* waitForInstanceState({ instanceId, targetStates: target, session })

    // 6. Read back the VM's actual running hash (truthful `code.hash`;
    //    divergence → the next reconcile restarts again). Only when the VM was
    //    (re)started this pass — otherwise trust the persisted state.
    const runningHash =
      Boolean(news.main) && (needsRestart || output === undefined)
        ? yield* readBackRunningHash({
            instance,
            port: news.port ?? 3000,
            shippedHash: runtime.code?.hash,
            previousHash: output?.code?.hash,
            session,
          })
        : output?.code?.hash

    // 7. Return — fresh Attributes (hosted state persisted via overrides)
    const fresh = yield* computeGrpcService.instance.get(instanceId)
    return toFriendlyAttributes(fresh, {
      runtimeUnitName: runtime.runtimeUnitName ?? output?.runtimeUnitName,
      assetPrefix: runtime.assetPrefix ?? output?.assetPrefix,
      code: runningHash !== undefined ? { hash: runningHash } : undefined,
      hostedBucketName: runtime.hostedBucketName ?? output?.hostedBucketName,
      hostedRegion: runtime.hostedRegion ?? output?.hostedRegion,
      hostedAccessKeyId: runtime.hostedAccessKeyId ?? output?.hostedAccessKeyId,
      hostedSecretAccessKey: runtime.hostedSecretAccessKey ?? output?.hostedSecretAccessKey,
    })
  }),

  delete: Effect.fn('Nebius.compute.v1.Instance.delete')(function* ({ id, output, session }) {
    // Hosted-runtime cleanup FIRST (S3 objects under the asset prefix + the
    // dedicated fetch key — idempotent): the bucket's own delete (stack
    // destroy) fails with BucketNotEmpty while objects remain.
    yield* (yield* loadHosted()).cleanupHostedRuntime({ id, output, session })
    if (output?.id) {
      yield* session.note(`Deleting Instance (${output.id})`)
      const computeGrpcService = yield* ComputeGrpc.ComputeGrpcService
      // Same helper the CRUD factory uses: a bounded attempt loop with a progress
      // ticker, raced with `raceFirst`. With `Effect.race` a *failing* delete
      // waited for the ticker forever — the failure was reported as an
      // interminable delete (see `Factory.runDeleteWithProgress`).
      yield* Factory.runDeleteWithProgress({
        label: 'Instance',
        id: output.id,
        deleteOnce: computeGrpcService.instance.delete(output.id).pipe(
          // Idempotent delete: NOT_FOUND means the resource is already gone
          // (e.g. cascaded away) — treat it as success.
          Effect.catchIf(
            (e: unknown): e is GrpcUtils.GrpcError => e instanceof GrpcUtils.GrpcError && e.code === 5,
            () => Effect.void,
          ),
        ),
        session,
      })
    }
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.compute.v1.Instance',
    validate: InstanceSchema.validateInstanceProps,
    service: ComputeGrpc.ComputeGrpcService,
    getById: (svc, id) => svc.instance.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.compute.v1.Instance',
    service: ComputeGrpc.ComputeGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.instance.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.compute.v1.Instance.diff')(function* ({ id, news, olds, output }) {
    news = news || {}
    // `exports` is the runtime program and it is an Effect — a host runtime
    // context always exposes one (`Server/Process.ts`), and `Platform` folds it
    // onto props for EVERY inline init Effect (the Effectful Constructor form,
    // which is also how bindings get registered). `isResolved` treats any Effect
    // as unresolved, so gating on the whole bag made every diff a silent no-op
    // for inline-impl instances — the same trap the AWS EC2 diff documents for
    // `contentInputs`. It is runtime-only state: never a spec field
    // (`hostedSpecInput` strips it) and never compared below.
    const rawNews = news as Record<string, unknown>
    // Hosted-entry guard (plan-time): does an inline init Effect exist? `exports`
    // is the signal, and it must be read before the destructure/validation drop it.
    yield* assertHostedEntryIsRunnable(id, news, rawNews.exports !== undefined)
    const { exports: _runtimeExports, ...resolvableNews } = rawNews
    // Keep the narrowed type (the comparisons below are typed against it) while
    // dropping the runtime-only key from everything downstream.
    news = resolvableNews as typeof news
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fails `alchemy plan` fast, BEFORE any API
    // call (same checks reconcile runs): boot-disk image required, 64 GiB
    // floor, network-interface ipAddress, GPU/platform pairing, …
    // (Side-effect only: diff reads the raw props, not the validated defaults.)
    yield* InstanceSchema.validateInstanceProps(news)

    const nameRequiresReplace = Factory.identityChangeRequiresReplace(news, olds)

    // Replace ordering: a NAME change is create-first (the new generation has a
    // different physical name), everything else keeps the identity — the parent
    // and the physical name — so a pinned `name` cannot be created while the old
    // generation still holds it. `Factory.replaceKeepingName` encodes that
    // (see its doc comment); a generated name is minted fresh per generation and
    // stays create-first, which is what keeps the old VM alive until the
    // replacement is up.
    if (nameRequiresReplace) {
      return { action: 'replace' }
    }

    // `gpuCluster` is create-only (`InstanceSpec.gpuCluster` — "GPU cluster ID
    // for InfiniBand interconnect. Only settable at creation"): neither the
    // update API nor reconcile's drift list can move a VM between clusters, so a
    // change in either direction is a replace. Compared on BOTH sides, unlike
    // the house "guarded on the news side" rule for in-place spec fields:
    // adding the cluster to or dropping it from an existing instance is the same
    // transition. Before this check existed the field was in NO comparison list,
    // so any change planned as "no changes" and the VM silently kept its
    // previous cluster.
    if (gpuClusterChanged(news, olds)) {
      return Factory.replaceKeepingName(news)
    }

    // `preemptible` cannot be toggled on a live VM (proto: "A preemptible VM
    // cannot be converted to a regular VM or vice versa. Once set, this field
    // cannot be removed…") → replace, rather than an update the API rejects.
    // Same both-sides comparison as above: adding OR removing it is the change.
    if ((news.preemptible !== undefined) !== (olds?.preemptible !== undefined)) {
      return Factory.replaceKeepingName(news)
    }

    // Host-mode toggle (`main` presence change) → replace (EC2 hostModeChanged).
    if (Boolean(olds?.main) !== Boolean(news.main)) {
      return Factory.replaceKeepingName(news)
    }

    // Hosted runtime props / user user-data changes → in-place update
    // (user-data is a spec field the update API accepts — Deviation 2).
    const stableAttrs: string[] = ['id', 'parentId', 'name']
    if (
      olds?.main !== news.main ||
      olds?.handler !== news.handler ||
      olds?.port !== news.port ||
      !ResourceUtils.specDeepEqual(olds?.env ?? {}, news.env ?? {}) ||
      !ResourceUtils.specDeepEqual(olds?.build ?? {}, news.build ?? {}) ||
      olds?.cloudInitUserData !== news.cloudInitUserData
    ) {
      return { action: 'update', stables: stableAttrs }
    }

    // Spec fields an update can change in place (the same list reconcile checks
    // for drift). Guarded on the news side so an omitted prop never plans work.
    if (
      (news.filesystems !== undefined &&
        !ResourceUtils.specDeepEqual(olds?.filesystems ?? [], news.filesystems)) ||
      (news.localDisks !== undefined && !ResourceUtils.specDeepEqual(olds?.localDisks, news.localDisks)) ||
      (news.reservationPolicy !== undefined &&
        !ResourceUtils.specDeepEqual(olds?.reservationPolicy, news.reservationPolicy)) ||
      (news.nvlInstanceGroupId !== undefined && olds?.nvlInstanceGroupId !== news.nvlInstanceGroupId)
    ) {
      return { action: 'update', stables: stableAttrs }
    }

    // A code-only change (the file behind `main` changed, props identical)
    // still needs a plan: re-bundle at plan time and compare the hash against
    // what the VM is running (mirrors the AWS EC2 diff).
    if (news.main && output?.code?.hash) {
      const { hash } = yield* (yield* loadHosted()).bundleProgram(id, news)
      if (hash !== output.code.hash) {
        return { action: 'update', stables: stableAttrs }
      }
    }

    return undefined
  }),
})
