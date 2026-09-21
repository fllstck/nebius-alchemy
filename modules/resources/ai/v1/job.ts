import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'

import * as NebiusJobSchema from '../../../../schemas/nebius/ai/v1/job.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as AiGrpc from '../../../api-client/ai.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as JobSchema from './job.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusJob = Alchemy.Resource<'Nebius.ai.v1.Job', JobSchema.JobProps, JobSchema.JobAttributes>

export const NebiusJob = Alchemy.Resource<NebiusJob>('Nebius.ai.v1.Job')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusJobSchema.Job} (metadata + spec + status)
 * into {@link JobSchema.JobAttributes}.
 */
const toFriendlyAttributes = (rawJob: NebiusJobSchema.Job): JobSchema.JobAttributes =>
  ResourceUtils.toFriendlyAttributes<JobSchema.JobAttributes>({
    rawResource: rawJob,
    resourceSchema: NebiusJobSchema.Job,
  })

// ----- PROVIDER

export const NebiusJobProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusJob>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusJob>, never, any>)
  : AlchemyProvider.succeed(NebiusJob, {
  // Observe → Ensure → Return (no Sync: the AI API has no update RPC)
  reconcile: Effect.fn('Nebius.ai.v1.Job.reconcile')(function* ({ id, news, output, session }) {
    news = news || {}

    // Validate user input at runtime
    news = yield* JobSchema.validateJobProps(news)

    const aiGrpcService = yield* AiGrpc.AiGrpcService

    // 1. Observe — fetch live state if we have a cached physical ID
    let job: NebiusJobSchema.Job | undefined
    if (output?.id) {
      job = yield* aiGrpcService.job
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
    if (!job) {
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

      yield* session.note(`Creating Nebius.ai.v1.Job (${name})`)
      job = yield* aiGrpcService.job
        .create({
          metadata: { parentId, name, labels },
          // Specs carry enum fields (port protocol, volume mount mode, disk
          // type) — fromJSON maps enum strings to int32, fromPartial would
          // pass them through and serialize NaN.
          spec: NebiusJobSchema.JobSpec.fromJSON(news),
        })
        .pipe(
          // Create can time out client-side while the backend still starts the
          // job (the long-running operation is created server-side before the
          // response reaches us). Recover by looking the job up by its
          // deterministic physical name and adopting it — otherwise destroy has
          // no ID to act on and silently leaks a running workload.
          Effect.catch((e: unknown) =>
            Effect.gen(function* () {
              const recovered = yield* aiGrpcService.job
                .getByName({ parentId, name })
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (recovered) {
                yield* session.note(`Recovered Nebius.ai.v1.Job (${recovered.metadata!.id}) after create failure`)
                return recovered
              }
              return yield* Effect.fail(e)
            }),
          ),
        )
    }

    // 3. Return — fresh Attributes
    return toFriendlyAttributes(job)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.ai.v1.Job',
    resourceLabel: 'Job',
    service: AiGrpc.AiGrpcService,
    deleteById: (svc, id) => svc.job.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.ai.v1.Job',
    validate: JobSchema.validateJobProps,
    service: AiGrpc.AiGrpcService,
    getById: (svc, id) => svc.job.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.ai.v1.Job',
    service: AiGrpc.AiGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.job.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // No update RPC → labels deliberately drift; any other spec change (or a
  // name change) requires replacing the resource.
  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.ai.v1.Job.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* JobSchema.validateJobProps(news)

    const newsWithoutLabels: Record<string, unknown> = { ...news }
    delete newsWithoutLabels.labels
    const oldsWithoutLabels: Record<string, unknown> = { ...olds }
    delete oldsWithoutLabels.labels

    return (
      Factory.identityChangeRequiresReplace(news, olds) ??
      (ResourceUtils.specDeepEqual(newsWithoutLabels, oldsWithoutLabels) ? undefined : Factory.replaceKeepingName(news))
    )
  }),
})
