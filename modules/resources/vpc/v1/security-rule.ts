import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'
import * as AlchemyDiff from 'alchemy/Diff'

import * as NebiusSecurityRuleSchema from '../../../../schemas/nebius/vpc/v1/security_rule.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as SecurityRuleSchema from './security-rule.schema.ts'
import * as Factory from '../../factory.ts'
import { resolveTenantId } from '../../shared/tenant.ts'

// ----- RESOURCE TYPES

export type NebiusSecurityRule = Alchemy.Resource<
  'Nebius.vpc.v1.SecurityRule',
  SecurityRuleSchema.SecurityRuleProps,
  SecurityRuleSchema.SecurityRuleAttributes
>

export const NebiusSecurityRule = Alchemy.Resource<NebiusSecurityRule>('Nebius.vpc.v1.SecurityRule')

// ----- HELPERS

const toFriendlyAttributes = (
  raw: NebiusSecurityRuleSchema.SecurityRule,
): SecurityRuleSchema.SecurityRuleAttributes =>
  ResourceUtils.toFriendlyAttributes<SecurityRuleSchema.SecurityRuleAttributes>({
    rawResource: raw,
    resourceSchema: NebiusSecurityRuleSchema.SecurityRule,
  })

// ----- PROVIDER

/**
 * Platform defaults (priority 500, STATEFUL) applied to the rule props BEFORE
 * the create/drift spec is built: the API echoes them back on create, so a
 * spec built without them differs from the echo (0 vs 500, 0 vs STATEFUL) →
 * every reconcile sees drift and rewrites the rule. Those spurious updates
 * have correlated with wedged ENI attachments in the hosted e2e — keep rules
 * stable. Exported for unit tests.
 */
export const withRuleSpecDefaults = (news: SecurityRuleSchema.SecurityRuleProps): Record<string, unknown> => ({
  ...news,
  priority: news.priority ?? 500,
  type: news.type ?? 'STATEFUL',
})

/** D8 bundle-safety guard — see modules/resources/storage/v1/bucket.ts (the bundler folds __ALCHEMY_RUNTIME__ in Worker bundles). */
export const NebiusSecurityRuleProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusSecurityRule>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusSecurityRule>, never, any>)
  : AlchemyProvider.succeed(NebiusSecurityRule, {
  // Security rules are children of a SecurityGroup — nuke deletes rules
  // before their group.
  nuke: { dependsOn: ['Nebius.vpc.v1.SecurityGroup'] },

  reconcile: Effect.fn('Nebius.vpc.v1.SecurityRule.reconcile')(function* ({ id, news, output, session, olds }) {
    news = news || {}
    news = yield* SecurityRuleSchema.validateSecurityRuleProps(news)

    // Platform defaults sent EXPLICITLY — see `withRuleSpecDefaults` (keeps
    // the spec echo equal to desired so the drift check never fires).
    const specNews = withRuleSpecDefaults(news)

    const vpcGrpcService = yield* VpcGrpc.VpcGrpcService

    // 1. Observe
    let rule: NebiusSecurityRuleSchema.SecurityRule | undefined
    if (output?.id) {
      rule = yield* vpcGrpcService.securityRule
        .get(output.id)
        .pipe(Effect.catchTag(['GrpcError'], (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    // 2. Ensure — parent is the SecurityGroup, not the Project
    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits `metadata.labels` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
    const labels = yield* Factory.mergedLabels(id, news.labels)
    if (!rule) {
      const name = news.name || (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      yield* session.note(`Creating Nebius.vpc.v1.SecurityRule (${name})`)
      rule = yield* vpcGrpcService.securityRule.create({
        metadata: { parentId: news.parentId, name, labels },
        // fromJSON required: SecurityRuleSpec has enums (direction, protocol, access, type)
        spec: NebiusSecurityRuleSchema.SecurityRuleSpec.fromJSON(specNews),
      })
    }

    // 3. Sync
    const desired = NebiusSecurityRuleSchema.SecurityRuleSpec.fromJSON(specNews)
    if (
      // Label drift triggers the same update: carrying the merged map in `metadata.labels` only
      // converges if this condition fires for a labels-only change (measured semantics in
      // `Factory.labelsDrifted`).
      Factory.labelsDrifted(rule.metadata?.labels, news.labels, olds?.labels) ||
      (rule.spec &&
        (rule.spec.access !== desired.access ||
          rule.spec.protocol !== desired.protocol ||
          rule.spec.priority !== desired.priority ||
          rule.spec.type !== desired.type ||
          !ResourceUtils.specDeepEqual(rule.spec.ingress, desired.ingress) ||
          !ResourceUtils.specDeepEqual(rule.spec.egress, desired.egress)))
    ) {
      yield* session.note(`Updating Nebius.vpc.v1.SecurityRule (${rule.metadata!.name})`)
      rule = yield* vpcGrpcService.securityRule.update({
        metadata: {
          id: rule.metadata!.id,
          resourceVersion: rule.metadata!.resourceVersion.toString(),
          labels,
        },
        spec: desired,
      })
    }

    return toFriendlyAttributes(rule)
  }),

  delete: Factory.makeCrudDelete({
    resourceName: 'Nebius.vpc.v1.SecurityRule',
    resourceLabel: 'SecurityRule',
    service: VpcGrpc.VpcGrpcService,
    deleteById: (svc, id) => svc.securityRule.delete(id),
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.vpc.v1.SecurityRule',
    validate: SecurityRuleSchema.validateSecurityRuleProps,
    service: VpcGrpc.VpcGrpcService,
    getById: (svc, id) => svc.securityRule.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // Security rules are children of a SecurityGroup — enumerate every security
  // group in the tenant and list each group's rules. Without this, nuke can't
  // delete rules before their group (Nebius does not cascade-delete), so group
  // deletes would fail or orphan rules.
  list: Effect.fn('Nebius.vpc.v1.SecurityRule.list')(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    const projects = yield* iam.project.list(tenantId)
    const rows = yield* Effect.forEach(projects, (project) =>
      vpc.securityGroup.list(project.metadata!.id).pipe(
        Effect.flatMap((groups) =>
          Effect.forEach(groups, (group) =>
            vpc.securityRule.list(group.metadata!.id).pipe(
              Effect.map((rules) => rules.map((r) => toFriendlyAttributes(r))),
              Effect.catch(() => Effect.succeed([] as SecurityRuleSchema.SecurityRuleAttributes[])),
            ),
          ),
        ),
        Effect.map((nested) => nested.flat()),
        Effect.catch(() => Effect.succeed([] as SecurityRuleSchema.SecurityRuleAttributes[])),
      ),
    )
    return rows.flat()
  }),

  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.vpc.v1.SecurityRule.diff')(function* ({ news, olds }) {
    news = news || {}
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* SecurityRuleSchema.validateSecurityRuleProps(news)

    // Name is immutable — changing it requires a replace
    if (Factory.identityChangeRequiresReplace(news, olds)) return { action: 'replace' }
    // Can't move a rule between security groups — must recreate
    if (news.parentId !== olds?.parentId) return { action: 'replace' }
    // access is immutable after creation
    if (news.access !== olds?.access) return Factory.replaceKeepingName(news)
    // priority is immutable after creation
    if (news.priority !== olds?.priority) return Factory.replaceKeepingName(news)
    // ingress source (sourceCidrs) is immutable after creation
    if (!ResourceUtils.specDeepEqual(news.ingress?.sourceCidrs, olds?.ingress?.sourceCidrs))
      return Factory.replaceKeepingName(news)

    return undefined
  }),
})
