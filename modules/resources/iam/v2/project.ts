import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'

import * as NebiusProjectSchema from '../../../../schemas/nebius/iam/v2/project.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as ProjectSchema from './project.schema.ts'
import * as Factory from '../../factory.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

// ----- RESOURCE TYPES

export type NebiusProject = Alchemy.Resource<
  'Nebius.iam.v2.Project',
  ProjectSchema.ProjectProps,
  ProjectSchema.ProjectAttributes
>

export const NebiusProject = Alchemy.Resource<NebiusProject>('Nebius.iam.v2.Project')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusProjectSchema.Project} (metadata + spec +
 * status) into {@link ProjectSchema.ProjectAttributes}.
 */
export const toFriendlyAttributes = (
  rawProject: NebiusProjectSchema.Project,
): ProjectSchema.ProjectAttributes => {
  // Proto stores state as `status.projectState` (enum number).
  // The JSON layer converts it to a string, but our schema expects `state`.
  const safe = NebiusProjectSchema.Project.toJSON(rawProject) as { status?: { projectState?: string } }
  return ResourceUtils.toFriendlyAttributes<ProjectSchema.ProjectAttributes>({
    rawResource: rawProject,
    resourceSchema: NebiusProjectSchema.Project,
    overrides: { state: safe.status?.projectState },
  })
}

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusProjectProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusProject>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusProject>, never, any>)
  : AlchemyProvider.succeed(NebiusProject, {
  // Observe → Ensure → Sync → Return
  reconcile: Effect.fn('Nebius.iam.v2.Project.reconcile')(function* ({ id, news, output, session }) {
    // When props are fully optional and the user passes none, news is undefined.
    // But region is required in the schema, so this won't happen in practice.
    news = news || ({} as ProjectSchema.ProjectProps)

    // Validate user input at runtime — catches what TypeScript can't
    news = yield* ProjectSchema.validateProjectProps(news)

    const iamGrpcService = yield* IamGrpc.IamGrpcService

    // 1. Observe — fetch live state if we have a cached physical ID
    let project: NebiusProjectSchema.Project | undefined
    if (output?.id) {
      project = yield* iamGrpcService.project
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — create if missing (with ownership tags)
    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!project) {
      const parentId = news.parentId || (yield* resolveTenantId())
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      yield* session.note(`Creating Nebius.iam.v2.Project (${name})`)
      project = yield* iamGrpcService.project.create({
        metadata: { parentId, name, labels },
        spec: NebiusProjectSchema.ProjectSpec.fromPartial({ region: news.region }),
      })
    }

    // 3. Sync — update if spec drifted from desired
    const desired = NebiusProjectSchema.ProjectSpec.fromPartial({ region: news.region })
    if (project.spec && project.spec.region !== desired.region) {
      yield* session.note(`Updating Nebius.iam.v2.Project (${project.metadata!.name})`)
      project = yield* iamGrpcService.project.update({
        metadata: {
          id: project.metadata!.id,
          resourceVersion: project.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: desired,
      })
    }

    // 4. Return — fresh Attributes
    return toFriendlyAttributes(project)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.iam.v2.Project',
    resourceLabel: 'Project',
    service: IamGrpc.IamGrpcService,
    deleteById: (svc, id) => svc.project.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.iam.v2.Project',
    validate: ProjectSchema.validateProjectProps,
    service: IamGrpc.IamGrpcService,
    getById: (svc, id) => svc.project.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Effect.fn('Nebius.iam.v2.Project.list')(function* () {
    const svc = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    const items = yield* svc.project.list(tenantId)
    return items
      .filter((p) => !p.metadata?.name?.startsWith('default-'))
      .map(toFriendlyAttributes)
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.iam.v2.Project.diff')(function* ({ news, olds }) {
    news = news || ({} as ProjectSchema.ProjectProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* ProjectSchema.validateProjectProps(news)

    // Name is immutable per proto — changing it requires a replace
    if (Factory.identityChangeRequiresReplace(news, olds)) return { action: 'replace' }

    // region changes can be done in-place via update
    return undefined
  }),
})
