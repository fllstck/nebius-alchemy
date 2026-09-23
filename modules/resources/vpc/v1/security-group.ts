import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'

import * as NebiusSecurityGroupSchema from '../../../../schemas/nebius/vpc/v1/security_group.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as SecurityGroupSchema from './security-group.schema.ts'
import * as Factory from '../../factory.ts'

// ----- RESOURCE TYPES

export type NebiusSecurityGroup = Alchemy.Resource<
  'Nebius.vpc.v1.SecurityGroup',
  SecurityGroupSchema.SecurityGroupProps,
  SecurityGroupSchema.SecurityGroupAttributes
>

export const NebiusSecurityGroup = Alchemy.Resource<NebiusSecurityGroup>('Nebius.vpc.v1.SecurityGroup')

// ----- HELPERS

export const toFriendlyAttributes = (
  raw: NebiusSecurityGroupSchema.SecurityGroup,
): SecurityGroupSchema.SecurityGroupAttributes =>
  ResourceUtils.toFriendlyAttributes<SecurityGroupSchema.SecurityGroupAttributes>({
    rawResource: raw,
    resourceSchema: NebiusSecurityGroupSchema.SecurityGroup,
  })

// ----- PROVIDER

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusSecurityGroupProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusSecurityGroup>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusSecurityGroup>, never, any>)
  : AlchemyProvider.succeed(NebiusSecurityGroup, {
  reconcile: Effect.fn('Nebius.vpc.v1.SecurityGroup.reconcile')(function* ({ id, news, output, session, olds }) {
    news = news || {}
    news = yield* SecurityGroupSchema.validateSecurityGroupProps(news)

    const vpcGrpcService = yield* VpcGrpc.VpcGrpcService

    // 1. Observe
    let sg: NebiusSecurityGroupSchema.SecurityGroup | undefined
    if (output?.id) {
      sg = yield* vpcGrpcService.securityGroup
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure
    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!sg) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      yield* session.note(`Creating Nebius.vpc.v1.SecurityGroup (${name})`)
      sg = yield* vpcGrpcService.securityGroup.create({
        metadata: { parentId, name, labels },
        spec: NebiusSecurityGroupSchema.SecurityGroupSpec.fromJSON(news),
      })
    }

    // 3. Sync
    const desired = NebiusSecurityGroupSchema.SecurityGroupSpec.fromJSON(news)
    if ((sg.spec && sg.spec.networkId !== desired.networkId) || Factory.labelsDrifted(sg.metadata?.labels, news.labels, olds?.labels)) {
      yield* session.note(`Updating Nebius.vpc.v1.SecurityGroup (${sg.metadata!.name})`)
      sg = yield* vpcGrpcService.securityGroup.update({
        metadata: {
          id: sg.metadata!.id,
          resourceVersion: sg.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(sg)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.vpc.v1.SecurityGroup',
    resourceLabel: 'SecurityGroup',
    service: VpcGrpc.VpcGrpcService,
    deleteById: (svc, id) => svc.securityGroup.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.vpc.v1.SecurityGroup',
    validate: SecurityGroupSchema.validateSecurityGroupProps,
    service: VpcGrpc.VpcGrpcService,
    getById: (svc, id) => svc.securityGroup.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.vpc.v1.SecurityGroup',
    service: VpcGrpc.VpcGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.securityGroup.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.vpc.v1.SecurityGroup.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* SecurityGroupSchema.validateSecurityGroupProps(news)

    if (Factory.identityChangeRequiresReplace(news, olds)) return { action: 'replace' }
    // Spec-only change (parent and name unchanged): keep the identity — see
    // Factory.replaceKeepingName.
    if (news.networkId !== olds?.networkId) return Factory.replaceKeepingName(news)

    return undefined
  }),
})
