import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Clock from 'effect/Clock'
import * as Schedule from 'effect/Schedule'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyServer from 'alchemy/Server'

import * as NebiusInstanceSchema from '../../../../schemas/nebius/compute/v1/instance.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ComputeGrpc from '../../../api-client/compute.ts'
import * as GrpcUtils from '../../../api-client/grpc-utils.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as InstanceSchema from './instance.schema.ts'
import * as Hosted from './hosted.ts'
import * as Factory from '../../factory.ts'

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
 * `reifyBoundConfigProvider` interceptor — `Config.string('NEBIUS_REGION')`
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
  transformProps: (id, props) => Hosted.transformInstanceProps(id, props),
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
const HOSTED_SPEC_KEYS = new Set(['main', 'handler', 'port', 'env', 'build', 'isExternal', 'bucket', 'hosted'])

/**
 * The spec INPUT: the user's props minus the hosted props, with the merged
 * cloud-init user-data (generated bootstrap first, user's after) injected.
 * Exported for unit tests (spec-stripping invariant).
 */
export const hostedSpecInput = (news: InstanceSchema.InstanceProps, userData: string | undefined): Record<string, unknown> => {
  const spec: Record<string, unknown> = { ...news }
  for (const key of HOSTED_SPEC_KEYS) delete spec[key]
  if (userData !== undefined) spec.cloudInitUserData = userData
  return spec
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
const waitForInstanceState = Effect.fn('waitForInstanceState')(function* ({
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
    ?.map((networkInterface) => networkInterface.publicIpAddress?.address)
    .find((address) => address)
  if (!publicIp || shippedHash === undefined) return shippedHash

  const probeUp = Effect.tryPromise(() =>
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
  reconcile: Effect.fn('Nebius.compute.v1.Instance.reconcile')(function* ({ id, news, output, bindings, session }) {
    news = news || {}

    // Validate user input at runtime
    news = yield* InstanceSchema.validateInstanceProps(news)

    const computeGrpcService = yield* ComputeGrpc.ComputeGrpcService

    // Host mode: bundle → ship → resolve the runtime (user-data + state).
    // Low-level mode: passthrough (runtime.userData = the user's cloud-init).
    const runtime = yield* Hosted.resolveHostedRuntime({ id, news, bindings, output })

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
    const parentId = news.parentId || (yield* Config.string('NEBIUS_PROJECT_ID'))
    if (!instance) {
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

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
    const specDrifted = (() => {
      if (!instance.spec) return false
      return (
        !AlchemyDiff.deepEqual(instance.spec.resources, desired.resources) ||
        !AlchemyDiff.deepEqual(instance.spec.bootDisk, desired.bootDisk) ||
        !AlchemyDiff.deepEqual(instance.spec.networkInterfaces, desired.networkInterfaces) ||
        !AlchemyDiff.deepEqual(instance.spec.secondaryDisks, desired.secondaryDisks) ||
        !AlchemyDiff.deepEqual(instance.spec.serviceAccountId, desired.serviceAccountId) ||
        instance.spec.cloudInitUserData !== desired.cloudInitUserData ||
        instance.spec.stopped !== desired.stopped
      )
    })()
    if (specDrifted) {
      yield* session.note(`Updating Nebius.compute.v1.Instance (${instance.metadata!.name})`)
      // The compute API requires metadata.parentId on update (unlike VPC
      // resources) — omitting it yields `INVALID_ARGUMENT: ParentID is invalid`.
      instance = yield* computeGrpcService.instance.update({
        metadata: {
          id: instanceId,
          parentId,
          resourceVersion: instance.metadata!.resourceVersion.toString(),
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
    yield* Hosted.cleanupHostedRuntime({ id, output, session })
    if (output?.id) {
      yield* session.note(`Deleting Instance (${output.id})`)
      const computeGrpcService = yield* ComputeGrpc.ComputeGrpcService
      const started = yield* Clock.currentTimeMillis
      yield* Effect.race(
        // Idempotent delete: NOT_FOUND means the resource is already gone
        // (e.g. cascaded away) — treat it as success.
        computeGrpcService.instance.delete(output.id).pipe(
          Effect.catchIf(
            (e: unknown): e is GrpcUtils.GrpcError => e instanceof GrpcUtils.GrpcError && e.code === 5,
            () => Effect.void,
          ),
        ),
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(30_000)
            const elapsedSec = Math.round(((yield* Clock.currentTimeMillis) - started) / 1000)
            yield* session.note(`Still deleting Instance (${output.id}) — ${elapsedSec}s elapsed`)
          }
        }),
      )
    }
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.compute.v1.Instance',
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
    if (!AlchemyDiff.isResolved(news)) return undefined

    const nameRequiresReplace = Factory.nameChangeRequiresReplace(news, olds)

    // Host-mode toggle (`main` presence change) → replace (EC2 hostModeChanged).
    if (nameRequiresReplace || Boolean(olds?.main) !== Boolean(news.main)) {
      return { action: 'replace' }
    }

    // Hosted runtime props / user user-data changes → in-place update
    // (user-data is a spec field the update API accepts — Deviation 2).
    const stableAttrs: string[] = ['id', 'parentId', 'name']
    if (
      olds?.main !== news.main ||
      olds?.handler !== news.handler ||
      olds?.port !== news.port ||
      !AlchemyDiff.deepEqual(olds?.env ?? {}, news.env ?? {}) ||
      !AlchemyDiff.deepEqual(olds?.build ?? {}, news.build ?? {}) ||
      olds?.cloudInitUserData !== news.cloudInitUserData
    ) {
      return { action: 'update', stables: stableAttrs }
    }

    // A code-only change (the file behind `main` changed, props identical)
    // still needs a plan: re-bundle at plan time and compare the hash against
    // what the VM is running (mirrors the AWS EC2 diff).
    if (news.main && output?.code?.hash) {
      const { hash } = yield* Hosted.bundleProgram(id, news)
      if (hash !== output.code.hash) {
        return { action: 'update', stables: stableAttrs }
      }
    }

    return undefined
  }),
})
