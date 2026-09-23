/**
 * Read-only probe of the `capacity-blocks` host (TASKS.md §"Next workstream").
 *
 * Two questions the file cannot answer by reading it:
 *
 * 1. Is `capacity-blocks.billing-cpl.api.nebius.cloud:443` reachable and
 *    authenticated from this environment? (It is a *different host* from the
 *    capacity-advisor the ResourceAdvice action already uses.)
 * 2. Does `CapacityAllowanceService/List` return **implicit** rows for a
 *    `(project, capacity-block-group)` pair that was never explicitly created?
 *    The proto says it does ("Lists non-created Capacity Allowances as well for
 *    clarity, showing the default limit"), and if true, a provider whose `list`
 *    feeds `alchemy unsafe nuke` would reset every project's limits to default.
 *
 * Read-only: `list` on three services. Nothing is created, updated or deleted.
 *
 *   bun spikes/capacity-blocks-probe.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as GrpcUtils from '../modules/api-client/grpc-utils.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'
import { CapacityAllowanceServiceClient } from '../schemas/nebius/capacity/v1/capacity_allowance_service.ts'
import {
  ListCapacityAllowancesRequest,
  ListCapacityAllowancesByCapacityBlockGroupRequest,
  GetCapacityAllowanceByParentAndCapacityBlockGroupRequest,
} from '../schemas/nebius/capacity/v1/capacity_allowance_service.ts'
import { CapacityBlockGroupServiceClient } from '../schemas/nebius/capacity/v1/capacity_block_group_service.ts'
import {
  ListCapacityBlockGroupsRequest,
  ListCapacityBlockGroupResourcesRequest,
} from '../schemas/nebius/capacity/v1/capacity_block_group_service.ts'
import { CapacityIntervalServiceClient } from '../schemas/nebius/capacity/v1/capacity_interval_service.ts'
import { ListCapacityIntervalsRequest } from '../schemas/nebius/capacity/v1/capacity_interval_service.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule

const authLayer = Layer.mergeAll(ProfileStoreLive, NebiusAuthModule.NebiusAuth).pipe(
  Layer.provide(CredentialsStoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      PlatformNode.NodeServices.layer,
      SaTokenModule.SaTokenMinterLive,
      SaBootstrapModule.SaBootstrapLive,
    ),
  ),
)

const program = Effect.gen(function* () {
  const allowance = yield* GrpcUtils.makeGrpcService(CapacityAllowanceServiceClient)

  // The project id this repo's .env carries (verified via `nebius iam project get`).
  const projectId = process.env.NEBIUS_PROJECT_ID ?? ''
  console.log(`project: ${projectId}`)

  const listResult = yield* allowance
    .list(ListCapacityAllowancesRequest.fromPartial({ parentId: projectId, pageSize: 100 }))
    .pipe(Effect.catch((e) => Effect.succeed({ items: [], nextPageToken: '', failed: String(e) })))
  console.log('\n== List(project) ==')
  console.log(JSON.stringify(listResult, null, 2).slice(0, 2500))

  // CapacityBlockGroup list is empty for this tenant (probed 2026-09-23), so this
  // is expected to answer NOT_FOUND — the point is which error shape it gives.
  const pairResult = yield* allowance
    .getByParentAndCapacityBlockGroup(
      GetCapacityAllowanceByParentAndCapacityBlockGroupRequest.fromPartial({
        parentId: projectId,
        capacityBlockGroupId: 'capacityblockgroup-doesnotexist',
      }),
    )
    .pipe(Effect.catch((e) => Effect.succeed({ failed: String(e) })))
  console.log('\n== GetByParentAndCapacityBlockGroup(nonexistent) ==')
  console.log(JSON.stringify(pairResult, null, 2).slice(0, 1200))

  const byGroup = yield* allowance
    .listByCapacityBlockGroup(
      ListCapacityAllowancesByCapacityBlockGroupRequest.fromPartial({
        capacityBlockGroupId: 'capacityblockgroup-doesnotexist',
        pageSize: 100,
      }),
    )
    .pipe(Effect.catch((e) => Effect.succeed({ items: [], nextPageToken: '', failed: String(e) })))
  console.log('\n== ListByCapacityBlockGroup(nonexistent) ==')
  console.log(JSON.stringify(byGroup, null, 2).slice(0, 1200))

  // ── page-size acceptance on the two other list endpoints ────────────────
  // `nvl-instance-group` rejects `pageSize: 100` with `3 INVALID_ARGUMENT`
  // while its neighbours accept it, so an unset page size is the safe default
  // unless probed. An error whose text is NOT about the page size also counts
  // as "the request shape is accepted" (the validation runs field by field).
  const tenantId = process.env.NEBIUS_TENANT_ID ?? 'tenant-e00xt8cvv67054nhsj'
  const blockGroups = yield* (yield* GrpcUtils.makeGrpcService(CapacityBlockGroupServiceClient))
    .list(ListCapacityBlockGroupsRequest.fromPartial({ parentId: tenantId, pageSize: 100 }))
    .pipe(Effect.catch((e) => Effect.succeed({ items: [], nextPageToken: '', failed: String(e) })))
  console.log('\n== ListCapacityBlockGroups(pageSize=100) ==')
  console.log(JSON.stringify(blockGroups, null, 2).slice(0, 800))

  const blockGroupResources = yield* (yield* GrpcUtils.makeGrpcService(CapacityBlockGroupServiceClient))
    .listResources(ListCapacityBlockGroupResourcesRequest.fromPartial({ id: 'capacityblockgroup-doesnotexist' }))
    .pipe(Effect.catch((e) => Effect.succeed({ resourceIds: [], failed: String(e) })))
  console.log('\n== ListCapacityBlockGroupResources(nonexistent) ==')
  console.log(JSON.stringify(blockGroupResources, null, 2).slice(0, 800))

  const intervals = yield* (yield* GrpcUtils.makeGrpcService(CapacityIntervalServiceClient))
    .list(ListCapacityIntervalsRequest.fromPartial({ parentId: 'capacityblockgroup-doesnotexist', pageSize: 100 }))
    .pipe(Effect.catch((e) => Effect.succeed({ items: [], nextPageToken: '', failed: String(e) })))
  console.log('\n== ListCapacityIntervals(pageSize=100, nonexistent parent) ==')
  console.log(JSON.stringify(intervals, null, 2).slice(0, 800))
})

// Compose the graph up front and provide it once — chaining `Effect.provide`
// calls breaks layer lifecycle (`multipleEffectProvide`), and `Layer.mergeAll`
// would build these in parallel without satisfying the dependency chain.
const transportLayer = NebiusGrpcTransportLive.pipe(
  Layer.provide(fromAuthProvider),
  Layer.provide(authLayer),
)

try {
  await Effect.runPromise(program.pipe(Effect.provide(transportLayer), Effect.scoped))
} catch (error) {
  console.error('PROBE FAILED:', error)
  process.exitCode = 1
}
