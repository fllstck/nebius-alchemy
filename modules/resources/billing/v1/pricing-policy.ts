import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Layer from 'effect/Layer'
import * as Alchemy from 'alchemy'
import * as AlchemyProvider from 'alchemy/Provider'
import * as AlchemyDiff from 'alchemy/Diff'
import * as AlchemyTags from 'alchemy/Tags'
import * as AlchemyPhysicalName from 'alchemy/PhysicalName'

import * as NebiusPricingPolicySchema from '../../../../schemas/nebius/billing/v1/pricing_policy.ts'
import * as BillingGrpc from '../../../api-client/billing.ts'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as ResourceUtils from '../../utilities.ts'

import * as PricingPolicySchema from './pricing-policy.schema.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'
import * as Factory from '../../factory.ts'

// ---------------------------------------------------------------------------
// Nebius.billing.v1.PricingPolicy
// ---------------------------------------------------------------------------
//
// The billing resource the `pricing_model` oneof's `spot_pricing_policy { id }` arm names: a
// project-scoped auction bid (platform + max price per GPU hour) that decides whether a preemptible VM
// may start and whether it is preempted. It provisions nothing, so unlike everything else in the
// compute-adjacent families it can be verified live for pennies.
//
// **Every spec change is a REPLACE, and that is a measurement** (`spikes/billing-update-shape-probe.ts`,
// 2026-09-24): `Update` answers a bare `3 INVALID_ARGUMENT: Request validation error` for every
// documented request shape — seven variants, including a byte-identical spec and a freshly read
// `resourceVersion` — so in-place convergence is impossible here rather than merely unused. The
// consequences are the same as for the other no-update-RPC resources: `diff` is the *only* convergence
// path (a prop it ignores is lost silently), and the props/`declared` split has to be explicit.

export type NebiusPricingPolicy = Alchemy.Resource<
  'Nebius.billing.v1.PricingPolicy',
  PricingPolicySchema.PricingPolicyProps,
  PricingPolicySchema.PricingPolicyAttributes
>

export const NebiusPricingPolicy = Alchemy.Resource<NebiusPricingPolicy>('Nebius.billing.v1.PricingPolicy')

// ----- HELPERS

/**
 * Flatten a protobuf {@link NebiusPricingPolicySchema.PricingPolicy} into attributes.
 *
 * Hand-mapped (like the Cluster's and the NodeGroup's) because `toFriendlyAttributes`' generic overlay
 * cannot un-nest the spec: the wire keeps the platform under `computeInstanceSpec.v1.platform` and the
 * bid under `pricing.maxPriceV1.maxPrice`, while the props are flat — so a generic merge would report
 * neither. `status.runningVmCount` is an int64 and arrives as a `Long` through the api-client (the JSON
 * rendering's decimal string is what it becomes here).
 */
const toFriendlyAttributes = (raw: NebiusPricingPolicySchema.PricingPolicy): PricingPolicySchema.PricingPolicyAttributes => ({
  id: pricingPolicyId(raw),
  parentId: IamV2Ids.ProjectId.make(raw.metadata?.parentId ?? ''),
  name: raw.metadata?.name ?? '',
  platform: raw.spec?.computeInstanceSpec?.v1?.platform ?? '',
  // The API normalizes what it stores: `"3.000"` is echoed as `"3"` (measured 2026-09-24). Reported as
  // it arrives — a comparison against props would be comparing against a *rendering*.
  maxPrice: raw.spec?.pricing?.maxPriceV1?.maxPrice ?? '',
  state:
    raw.status === undefined
      ? undefined
      : NebiusPricingPolicySchema.pricingPolicyStatus_StateToJSON(raw.status.state),
  schedulingState:
    raw.status === undefined
      ? undefined
      : NebiusPricingPolicySchema.pricingPolicyStatus_SchedulingStateToJSON(raw.status.schedulingState),
  skuId: raw.status?.skuId,
  currency: raw.status?.currency,
  runningVmCount: raw.status?.runningVmCount?.toString(),
})

/** The brand, applied at the boundary (metadata.id is a plain string in the generated schema). */
const pricingPolicyId = (raw: NebiusPricingPolicySchema.PricingPolicy) =>
  Ids.PricingPolicyId.make(raw.metadata?.id ?? '')

/** The nested spec the API wants, built from the flat props (the documented reshape). */
const specFromProps = (props: PricingPolicySchema.PricingPolicyProps) =>
  NebiusPricingPolicySchema.PricingPolicySpec.fromJSON({
    computeInstanceSpec: { v1: { platform: props.platform } },
    pricing: { maxPriceV1: { maxPrice: props.maxPrice } },
  })

/** The provider's own `delete`, with the running-VM pre-check in front of it. */
const crudDelete = Factory.makeCrudDelete({
  resourceName: 'Nebius.billing.v1.PricingPolicy',
  resourceLabel: 'Pricing policy',
  service: BillingGrpc.BillingGrpcService,
  deleteById: (svc, id) => svc.pricingPolicy.delete(id),
})

// ----- PROVIDER

export const NebiusPricingPolicyProvider: Layer.Layer<
  AlchemyProvider.Provider<NebiusPricingPolicy>,
  never,
  // oxlint-disable-next-line no-explicit-any — DCE guard: requirements wildcard (see doc comment above)
  any
> = globalThis.__ALCHEMY_RUNTIME__
  ? // oxlint-disable-next-line no-explicit-any — DCE guard: cast matches the annotated wildcard
    (undefined as unknown as Layer.Layer<AlchemyProvider.Provider<NebiusPricingPolicy>, never, any>)
  : AlchemyProvider.succeed(NebiusPricingPolicy, {
  reconcile: Effect.fn('Nebius.billing.v1.PricingPolicy.reconcile')(function* ({ id, news, output, session }) {
    news = yield* PricingPolicySchema.validatePricingPolicyProps(news)

    const svc = yield* BillingGrpc.BillingGrpcService

    let policy: NebiusPricingPolicySchema.PricingPolicy | undefined
    if (output?.id) {
      policy = yield* svc.pricingPolicy
        .get(output.id)
        .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    }

    if (!policy) {
      const parentId = news.parentId || (yield* Config.String('NEBIUS_PROJECT_ID'))
      const name =
        news.name ?? (yield* AlchemyPhysicalName.createPhysicalName({ id, maxLength: 63, lowercase: true }))
      const internalLabels = yield* AlchemyTags.createInternalTags(id)

      yield* session.note(`Creating Nebius.billing.v1.PricingPolicy (${name})`)
      policy = yield* svc.pricingPolicy.create({
        metadata: { parentId, name, labels: { ...internalLabels, ...news.labels } },
        spec: specFromProps(news),
      })
    }

    // No update path exists (see the file header) — a spec change is planned as a replace by `diff`.
    return toFriendlyAttributes(policy)
  }),

  delete: Effect.fn('Nebius.billing.v1.PricingPolicy.delete')(function* ({ output, session }) {
    const svc = yield* BillingGrpc.BillingGrpcService
    // The API refuses to delete a policy that still prices running VMs, and its own error is a bare
    // FAILED_PRECONDITION. The count is in `status`, so the provider names the consequence instead —
    // the GpuClusterNotEmpty pattern (a provider cannot see its dependents; here the resource can).
    const live = yield* svc.pricingPolicy
      .get(output.id)
      .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
    const running = live?.status?.runningVmCount
    if (running !== undefined && !running.isZero()) {
      return yield* new PricingPolicySchema.PricingPolicyHasRunningVms({
        id: output.id,
        runningVmCount: running.toString(),
      })
    }
    yield* crudDelete({ output, session })
  }),

  read: Factory.makeCrudRead({
    resourceName: 'Nebius.billing.v1.PricingPolicy',
    validate: PricingPolicySchema.validatePricingPolicyProps,
    service: BillingGrpc.BillingGrpcService,
    getById: (svc, id) => svc.pricingPolicy.get(id),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  list: Factory.makeTenantScopedList({
    resourceName: 'Nebius.billing.v1.PricingPolicy',
    service: BillingGrpc.BillingGrpcService,
    iamService: IamGrpc.IamGrpcService,
    projectList: (iam, tenantId) => iam.project.list(tenantId),
    projectId: (p) => p.metadata!.id,
    listByParent: (svc, parentId) => svc.pricingPolicy.list(parentId),
    toAttrs: (raw) => toFriendlyAttributes(raw),
  }),

  // diff — the ONLY convergence path (no update RPC): an identity change replaces, any spec change
  // replaces, and `labels` is the one declared exception (no update path sends labels anywhere, the
  // fleet-wide decision in AGENTS.md §Convergence).
  // eslint-disable-next-line require-yield
  diff: Effect.fn('Nebius.billing.v1.PricingPolicy.diff')(function* ({ news, olds }) {
    news = news || ({} as PricingPolicySchema.PricingPolicyProps)
    if (!AlchemyDiff.isResolved(news)) return undefined

    // Plan-time props validation — fail `alchemy plan` fast, before any API call.
    yield* PricingPolicySchema.validatePricingPolicyProps(news)

    const newsWithoutLabels: Record<string, unknown> = { ...news }
    delete newsWithoutLabels.labels
    const oldsWithoutLabels: Record<string, unknown> = { ...olds }
    delete oldsWithoutLabels.labels

    return (
      Factory.identityChangeRequiresReplace(news, olds) ??
      (ResourceUtils.specDeepEqual(newsWithoutLabels, oldsWithoutLabels)
        ? undefined
        : Factory.replaceKeepingName(news))
    )
  }),
})
