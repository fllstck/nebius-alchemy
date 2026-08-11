import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyServer from 'alchemy/Server'

import * as NebiusInstanceSchema from '../../../../schemas/nebius/compute/v1/instance.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ComputeGrpc from '../../../api-client/compute.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as InstanceSchema from './instance.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusInstance = Alchemy.Resource<
  'Nebius.compute.v1.Instance',
  InstanceSchema.InstanceProps,
  InstanceSchema.InstanceAttributes,
  never,
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
})

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusInstanceSchema.Instance} (metadata + spec + status)
 * into {@link InstanceSchema.InstanceAttributes}.
 *
 * Hosted-mode attrs (`runtimeUnitName`, `assetPrefix`, `code.hash`) are provider
 * state, not protobuf fields — threaded via `hostedOverrides` (the same way AWS
 * EC2 returns `roleArn`/`assetPrefix` from provider state).
 */
const toFriendlyAttributes = (
  rawInstance: NebiusInstanceSchema.Instance,
  hostedOverrides: Partial<
    Pick<InstanceSchema.InstanceAttributes, 'runtimeUnitName' | 'assetPrefix' | 'code'>
  > = {},
): InstanceSchema.InstanceAttributes =>
  ResourceUtils.toFriendlyAttributes<InstanceSchema.InstanceAttributes>({
    rawResource: rawInstance,
    resourceSchema: NebiusInstanceSchema.Instance,
    overrides: hostedOverrides,
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
  // Observe → Ensure → Sync → Return
  reconcile: Effect.fn('Nebius.compute.v1.Instance.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}

    // Validate user input at runtime
    news = yield* InstanceSchema.validateInstanceProps(news)

    const computeGrpcService = yield* ComputeGrpc.ComputeGrpcService

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
          spec: NebiusInstanceSchema.InstanceSpec.fromJSON(news),
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

    // 3. Sync — update if spec drifted from desired
    // Note: some fields are immutable (gpuCluster), update handles what's changeable.
    const desired = NebiusInstanceSchema.InstanceSpec.fromJSON(news)
    if (
      instance.spec &&
      (!AlchemyDiff.deepEqual(instance.spec.resources, desired.resources) ||
        !AlchemyDiff.deepEqual(instance.spec.bootDisk, desired.bootDisk) ||
        !AlchemyDiff.deepEqual(instance.spec.networkInterfaces, desired.networkInterfaces) ||
        !AlchemyDiff.deepEqual(instance.spec.secondaryDisks, desired.secondaryDisks) ||
        !AlchemyDiff.deepEqual(instance.spec.serviceAccountId, desired.serviceAccountId) ||
        instance.spec.stopped !== desired.stopped)
    ) {
      yield* session.note(`Updating Nebius.compute.v1.Instance (${instance.metadata!.name})`)
      // The compute API requires metadata.parentId on update (unlike VPC
      // resources) — omitting it yields `INVALID_ARGUMENT: ParentID is invalid`.
      instance = yield* computeGrpcService.instance.update({
        metadata: {
          id: instance.metadata!.id,
          parentId,
          resourceVersion: instance.metadata!.resourceVersion.toString(),
        },
        spec: desired,
      })
    }

    // 4. Return — fresh Attributes
    return toFriendlyAttributes(instance)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.compute.v1.Instance',
    resourceLabel: 'Instance',
    service: ComputeGrpc.ComputeGrpcService,
    deleteById: (svc, id) => svc.instance.delete(id),
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
  diff: Effect.fn('Nebius.compute.v1.Instance.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined
    return Factory.nameChangeRequiresReplace(news, olds)
  }),
})
