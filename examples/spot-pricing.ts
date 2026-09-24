/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Spot pricing — `billing.PricingPolicy` + the `pricing` prop
 *
 * Two things this example exists to show, because they only make sense together:
 *
 *   1. a **pricing policy** — the project-scoped auction bid that caps what a
 *      preemptible GPU VM may pay per hour. It provisions nothing, so it is the
 *      cheapest resource in this package to create and destroy;
 *   2. the **`pricing` prop** on `compute.Instance` (the same prop exists on
 *      `mk8s.NodeGroup.template`, `ai.Job` and `ai.Endpoint`), which is how a VM is
 *      told to use it.
 *
 * The prop is a deliberate reshape of a flat proto oneof, so it reads as one
 * choice rather than three fields:
 *
 *   { onDemand: true }                          → a regular, non-preemptible VM
 *   { followsSpotPrice: true }                  → preemptible, accepts the market price
 *   { spotPricingPolicy: { id: policy.id } }    → preemptible, capped at the policy's bid
 *
 * ⚠️ **The API requires the arm to match `preemptible`** — `on_demand` for a
 * non-preemptible VM, the two spot arms for a preemptible one. A mismatch is a
 * **plan-time error** here rather than an apply-time one, because the API's own
 * message is the authority (`spot-pricing-policy pricing requires a preemptible
 * instance`, measured live 2026-09-24).
 *
 * ⚠️ **This example deploys a real VM** (one `4vcpu-16gb` instance). It is not
 * preemptible: this tenant's CPU platforms reject `preemptible: true`
 * (`3 INVALID_ARGUMENT: Preemptible is invalid`, measured 2026-09-10), which is why
 * the spot arms are shown commented — they need a GPU platform, i.e. real GPU
 * money. Always `alchemy destroy --yes`.
 *
 * Usage:
 *   alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID     (required)
 *   SUBNET_ID             (required — the VM's subnet)
 *   NEBIUS_SA_ID          (required — the VM's service account)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Config from 'effect/Config'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  policyId: Nebius.billing.PricingPolicyId
  policyName: string
  /** `STATE_ACTIVE` / `STATE_CREATING` / … — the service's own spelling. */
  policyState: string | undefined
  /** Whether new VMs may start under the bid right now (`SCHEDULING_STATE_*`). */
  policySchedulingState: string | undefined
  /** The API normalizes the price it stores: `'3.000'` is echoed as `'3'`. */
  policyMaxPrice: string
  /** VMs currently running under the policy — nonzero blocks both changes and deletion. */
  policyRunningVmCount: string | undefined
  instanceId: Nebius.compute.InstanceId
  instanceState: string
}

export default Alchemy.Stack(
  'SpotPricing',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const projectId = yield* Config.String('NEBIUS_PROJECT_ID')
    const subnetId = yield* Config.String('SUBNET_ID')
    const serviceAccountId = yield* Config.String('NEBIUS_SA_ID')
    void projectId

    // ── The bid ─────────────────────────────────────────────────────────────
    // `platform` and `maxPrice` are the whole spec: which hardware this bid is for,
    // and the ceiling per GPU hour — a decimal **string** with up to three
    // fractional digits, because it is money rather than a number to do arithmetic
    // on.
    //
    // Three measured behaviours to expect:
    //   * the API **normalizes** the price it stores (`'3.000'` → `'3'`), which is
    //     what `policyMaxPrice` reports below;
    //   * a bid **below the current market price is accepted** and simply blocks
    //     scheduling until the market falls to it — the policy reports
    //     `SCHEDULING_STATE_BLOCKED` instead of failing the deploy;
    //   * `metadata.labels` are **accepted and discarded** by this service, so this
    //     resource can never report itself as owned and every read comes back
    //     `Unowned`. That is the API's behaviour, not an omission here (asserted in
    //     `tests/resources/billing/v1/pricing-policy.integration.test.ts`).
    //
    // ⚠️ Its `Update` RPC rejects every documented request shape, so a change to
    // `platform` or `maxPrice` is planned as a **replace** — delete-then-create is
    // the API's shape, not a choice made here.
    const policy = yield* Nebius.billing.PricingPolicy('GpuH100Bid', {
      platform: 'gpu-h100-sxm',
      maxPrice: '3.000',
    })

    // ── A VM that prices itself explicitly ──────────────────────────────────
    // `{ onDemand: true }` is what the platform would apply anyway; it is spelled
    // out because it is the arm that pairs with a non-preemptible VM, and because it
    // exercises the round trip — a create that pins *nothing* echoes no pricing
    // field at all (measured), so the prop is never materialized behind your back.
    //
    // ⚠️ On this resource a pricing change is accepted only on a **stopped**
    // instance: the API answers `9 FAILED_PRECONDITION: spec fields [pricing_model]
    // update could be done with stopped instance`. Repeating an already-set arm in an
    // update is fine, so pinning it does not poison later updates — but to *change*
    // the mode, set `stopped: true` first (or recreate the VM).
    const instance = yield* Nebius.compute.Instance('OnDemandVm', {
      serviceAccountId: Nebius.iam.ServiceAccountId.make(serviceAccountId),
      resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
      bootDisk: {
        attachMode: 'READ_WRITE',
        managedDisk: {
          name: 'spot-pricing-boot',
          spec: {
            type: 'NETWORK_SSD',
            sizeGibibytes: 64,
            sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
          },
        },
      },
      networkInterfaces: [
        { subnetId: Nebius.vpc.SubnetId.make(subnetId), name: 'eth0', ipAddress: { allocationId: '' } },
      ],
      pricing: { onDemand: true },
    })

    // ── The spot arms (commented: they need GPU capacity) ───────────────────
    // Both require `preemptible`, and `preemptible` needs a GPU platform here. The
    // policy above is what `spotPricingPolicy` names — "preemptible, but never above
    // the bid":
    //
    // const spotVm = yield* Nebius.compute.Instance('SpotVm', {
    //   serviceAccountId: Nebius.iam.ServiceAccountId.make(serviceAccountId),
    //   resources: { platform: 'gpu-h100-sxm', preset: '1gpu-16vcpu-200gb' },
    //   bootDisk: {
    //     attachMode: 'READ_WRITE',
    //     managedDisk: {
    //       name: 'spot-pricing-spot-boot',
    //       spec: { type: 'NETWORK_SSD', sizeGibibytes: 512, sourceImageFamily: { imageFamily: 'ubuntu24.04' } },
    //     },
    //   },
    //   networkInterfaces: [
    //     { subnetId: Nebius.vpc.SubnetId.make(subnetId), name: 'eth0', ipAddress: { allocationId: '' } },
    //   ],
    //   preemptible: { onPreemption: 'STOP' },
    //   // Exactly one arm, and a mismatch with `preemptible` is a plan-time error.
    //   pricing: { spotPricingPolicy: { id: policy.id } },
    // })
    //
    // The same choice exists on a managed node group. It is a *template* change, so
    // expect a node roll-out (and note the two GB300 preconditions mk8s adds:
    // fixed sizing, non-preemptible — the opposite of this example, which is why it
    // is only a snippet):
    //
    // yield* Nebius.mk8s.NodeGroup('SpotNodes', {
    //   parentId: cluster.id,
    //   fixedNodeCount: 1,
    //   template: {
    //     os: 'ubuntu24.04',
    //     resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
    //     bootDisk: { type: 'NETWORK_SSD', sizeGibibytes: 64 },
    //     networkInterfaces: [{ subnetId: subnetId }],
    //     serviceAccountId: Nebius.iam.ServiceAccountId.make(serviceAccountId),
    //     cloudInitUserData: '#cloud-config\n',
    //     preemptible: true,
    //     pricing: { followsSpotPrice: true },
    //   },
    // })

    return {
      policyId: policy.id,
      policyName: policy.name,
      policyState: policy.state,
      policySchedulingState: policy.schedulingState,
      policyMaxPrice: policy.maxPrice,
      policyRunningVmCount: policy.runningVmCount,
      instanceId: instance.id,
      instanceState: instance.state,
    }
  }),
)
