/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Actions — discovery actions for existing resources
 *
 * Demonstrates all read-only discovery actions: list-all and single-get for
 * each resource type. No Alchemy state is created — each is a pure read
 * action visible in `alchemy plan`.
 *
 * Usage:
 *   NEBIUS_TENANT_ID=<tenant-id> alchemy deploy --yes
 *   alchemy destroy --yes
 *
 * Environment variables:
 *   NEBIUS_API_KEY        (required — auto-populated from Nebius CLI)
 *   NEBIUS_PROJECT_ID     (required)
 *   NEBIUS_TENANT_ID      (required for GetProjects / GetGroups)
 *   NEBIUS_REGION         (optional)  Default: eu-north1
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export default Alchemy.Stack(
  'Actions',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // ── IAM: Projects ──────────────────────────────────────────────────────
    const projects = yield* Nebius.iam.action.ListProjects('AllProjects', {})
    const project = yield* Nebius.iam.action.GetProject('DefaultProject', {
      name: 'default-project-us-central1',
    })

    // ── IAM: Groups ────────────────────────────────────────────────────────
    const groups = yield* Nebius.iam.action.ListGroups('AllGroups', {
      parentId: project.id,
    })
    // No groups exist in this tenant, so skip GetGroup.

    // ── VPC: Networks ──────────────────────────────────────────────────────
    const networks = yield* Nebius.vpc.action.ListNetworks('AllNetworks', {
      parentId: project.id,
    })
    const network = yield* Nebius.vpc.action.GetNetwork('DefaultNetwork', {
      parentId: project.id,
      name: 'default-network',
    })

    // ── VPC: Subnets ───────────────────────────────────────────────────────
    const subnets = yield* Nebius.vpc.action.ListSubnets('AllSubnets', {
      parentId: project.id,
    })
    const subnet = yield* Nebius.vpc.action.GetSubnet('DefaultSubnet', {
      parentId: project.id,
      name: 'default-subnet-tcooh5ht',
    })

    // ── VPC: Route Tables ──────────────────────────────────────────────────
    const routeTables = yield* Nebius.vpc.action.ListRouteTables('AllRouteTables', {
      parentId: project.id,
    })
    const routeTable = yield* Nebius.vpc.action.GetRouteTable('DefaultRouteTable', {
      parentId: project.id,
      name: 'default-route-table-e9lvviwt',
    })

    // ── Quotas ─────────────────────────────────────────────────────────────
    const quotas = yield* Nebius.quotas.action.ListQuotas('AllQuotas', {
      parentId: project.id,
    })
    const quota = yield* Nebius.quotas.action.GetQuota('DefaultQuota', {
      name: 'compute.disk.count',
      region: 'eu-west1',
      parentId: project.id,
    })

    return {
      // IAM
      projects,
      project,
      groups,
      // VPC
      networks,
      network,
      subnets,
      subnet,
      routeTables,
      routeTable,
      // Quotas
      quotas,
      quota,
    }
  }) as any,
)
