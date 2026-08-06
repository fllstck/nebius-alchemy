import * as Effect from 'effect'
import * as NebiusNetworkServiceSchema from '../../schemas/nebius/vpc/v1/network_service.ts'
import type { Network } from '../../schemas/nebius/vpc/v1/network.ts'
import * as NebiusSubnetServiceSchema from '../../schemas/nebius/vpc/v1/subnet_service.ts'
import type { Subnet } from '../../schemas/nebius/vpc/v1/subnet.ts'
import * as NebiusSecurityGroupServiceSchema from '../../schemas/nebius/vpc/v1/security_group_service.ts'
import type { SecurityGroup } from '../../schemas/nebius/vpc/v1/security_group.ts'
import * as NebiusSecurityRuleServiceSchema from '../../schemas/nebius/vpc/v1/security_rule_service.ts'
import type { SecurityRule } from '../../schemas/nebius/vpc/v1/security_rule.ts'
import * as NebiusRouteTableServiceSchema from '../../schemas/nebius/vpc/v1/route_table_service.ts'
import type { RouteTable } from '../../schemas/nebius/vpc/v1/route_table.ts'
import * as NebiusRouteServiceSchema from '../../schemas/nebius/vpc/v1/route_service.ts'
import type { Route } from '../../schemas/nebius/vpc/v1/route.ts'
import * as NebiusPoolServiceSchema from '../../schemas/nebius/vpc/v1/pool_service.ts'
import type { Pool } from '../../schemas/nebius/vpc/v1/pool.ts'
import * as NebiusAllocationServiceSchema from '../../schemas/nebius/vpc/v1/allocation_service.ts'
import type { Allocation } from '../../schemas/nebius/vpc/v1/allocation.ts'
import * as GrpcUtils from './grpc-utils.ts'
import { NebiusGrpcTransport } from './GrpcTransport.ts'
import type { CreateInput, UpdateInput } from './types.ts'

// ---------------------------------------------------------------------------
// Network service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateNetworkInput = CreateInput

export type UpdateNetworkInput = UpdateInput

export interface CreateDefaultNetworkInput {
  readonly metadata: { parentId?: string; name?: string; labels?: Record<string, string> }
}

export interface NetworkService {
  readonly get: (id: string) => Effect.Effect.Effect<Network, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Network, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all networks in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Network>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateNetworkInput,
  ) => Effect.Effect.Effect<
    Network,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly createDefault: (
    req: CreateDefaultNetworkInput,
  ) => Effect.Effect.Effect<
    Network,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateNetworkInput,
  ) => Effect.Effect.Effect<
    Network,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Subnet service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateSubnetInput = CreateInput

export type UpdateSubnetInput = UpdateInput

export interface SubnetService {
  readonly get: (id: string) => Effect.Effect.Effect<Subnet, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Subnet, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all subnets in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Subnet>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all subnets in a network (paginates automatically). */
  readonly listByNetwork: (
    networkId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Subnet>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware (polling transparent, inputs simplified) ---

  readonly create: (
    req: CreateSubnetInput,
  ) => Effect.Effect.Effect<
    Subnet,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateSubnetInput,
  ) => Effect.Effect.Effect<
    Subnet,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// SecurityGroup service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateSecurityGroupInput = CreateInput

export type UpdateSecurityGroupInput = UpdateInput

export interface SecurityGroupService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<SecurityGroup, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<SecurityGroup, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all security groups in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<SecurityGroup>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all security groups in a network (paginates automatically). */
  readonly listByNetwork: (
    networkId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<SecurityGroup>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware ---

  readonly create: (
    req: CreateSecurityGroupInput,
  ) => Effect.Effect.Effect<
    SecurityGroup,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateSecurityGroupInput,
  ) => Effect.Effect.Effect<
    SecurityGroup,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// SecurityRule service — simplified, operation-aware interface
//
// NOTE: SecurityRule parent is a SecurityGroup ID, not a Project ID.
// ---------------------------------------------------------------------------

export interface CreateSecurityRuleInput {
  readonly metadata: { parentId: string; name?: string; labels?: Record<string, string> }
  readonly spec: {}
}

export type UpdateSecurityRuleInput = UpdateInput

export interface SecurityRuleService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<SecurityRule, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<SecurityRule, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all rules in a security group (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<SecurityRule>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware ---

  readonly create: (
    req: CreateSecurityRuleInput,
  ) => Effect.Effect.Effect<
    SecurityRule,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateSecurityRuleInput,
  ) => Effect.Effect.Effect<
    SecurityRule,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// RouteTable service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateRouteTableInput = CreateInput

export type UpdateRouteTableInput = UpdateInput

export interface RouteTableService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<RouteTable, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<RouteTable, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all route tables in a project (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<RouteTable>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all route tables in a network (paginates automatically). */
  readonly listByNetwork: (
    networkId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<RouteTable>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware ---

  readonly create: (
    req: CreateRouteTableInput,
  ) => Effect.Effect.Effect<
    RouteTable,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateRouteTableInput,
  ) => Effect.Effect.Effect<
    RouteTable,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Route service — simplified, operation-aware interface
//
// NOTE: Route parent is a RouteTable ID, not a Project ID.
// ---------------------------------------------------------------------------

export interface CreateRouteInput {
  readonly metadata: { parentId: string; name?: string; labels?: Record<string, string> }
  readonly spec: {}
}

export type UpdateRouteInput = UpdateInput

export interface RouteService {
  readonly get: (id: string) => Effect.Effect.Effect<Route, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Route, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  /** List all routes in a route table (paginates automatically). */
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Route>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  // --- Operation-aware ---

  readonly create: (
    req: CreateRouteInput,
  ) => Effect.Effect.Effect<
    Route,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateRouteInput,
  ) => Effect.Effect.Effect<
    Route,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Pool service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreatePoolInput = CreateInput

export type UpdatePoolInput = UpdateInput

export interface PoolService {
  readonly get: (id: string) => Effect.Effect.Effect<Pool, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Pool, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Pool>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly listBySourcePool: (
    poolId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Pool>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  readonly create: (
    req: CreatePoolInput,
  ) => Effect.Effect.Effect<
    Pool,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdatePoolInput,
  ) => Effect.Effect.Effect<
    Pool,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Allocation service — simplified, operation-aware interface
// ---------------------------------------------------------------------------

export type CreateAllocationInput = CreateInput

export type UpdateAllocationInput = UpdateInput

export interface AllocationService {
  readonly get: (
    id: string,
  ) => Effect.Effect.Effect<Allocation, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly getByName: (req: {
    parentId: string
    name: string
  }) => Effect.Effect.Effect<Allocation, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly list: (
    parentId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Allocation>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly listByPool: (
    poolId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Allocation>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>
  readonly listBySubnet: (
    subnetId: string,
  ) => Effect.Effect.Effect<ReadonlyArray<Allocation>, GrpcUtils.GrpcError | GrpcUtils.GrpcDeadlineExceededError>

  readonly create: (
    req: CreateAllocationInput,
  ) => Effect.Effect.Effect<
    Allocation,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly update: (
    req: UpdateAllocationInput,
  ) => Effect.Effect.Effect<
    Allocation,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
  readonly delete: (
    id: string,
  ) => Effect.Effect.Effect<
    void,
    GrpcUtils.GrpcError | GrpcUtils.OperationFailedError | GrpcUtils.GrpcDeadlineExceededError
  >
}

// ---------------------------------------------------------------------------
// Service shape & service tag
// ---------------------------------------------------------------------------

export interface VpcGrpcServiceShape {
  readonly network: NetworkService
  readonly subnet: SubnetService
  readonly securityGroup: SecurityGroupService
  readonly securityRule: SecurityRuleService
  readonly routeTable: RouteTableService
  readonly route: RouteService
  readonly pool: PoolService
  readonly allocation: AllocationService
}

export class VpcGrpcService extends Effect.Context.Service<VpcGrpcService, VpcGrpcServiceShape>()('VpcGrpcService') {}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const VpcGrpcServiceLive = Effect.Layer.effect(
  VpcGrpcService,
  Effect.Effect.gen(function* () {
    const transport = yield* NebiusGrpcTransport

    // --- Network service ---

    const rawNetwork = yield* GrpcUtils.makeGrpcService(NebiusNetworkServiceSchema.NetworkServiceClient)

    const polledNetwork = GrpcUtils.wrapWithOperationPolling(rawNetwork, {
      serviceName: 'nebius.vpc.v1.NetworkService',
      polling: ['create', 'createDefault', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusNetworkServiceSchema.GetNetworkRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusNetworkServiceSchema.GetNetworkRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusNetworkServiceSchema.GetNetworkByNameRequest.fromPartial(req),
        create: (req: CreateNetworkInput) => NebiusNetworkServiceSchema.CreateNetworkRequest.fromPartial(req),
        createDefault: (req: CreateDefaultNetworkInput) =>
          NebiusNetworkServiceSchema.CreateDefaultNetworkRequest.fromPartial(req),
        update: (req: UpdateNetworkInput) => NebiusNetworkServiceSchema.UpdateNetworkRequest.fromPartial(req),
        delete: (id: string) => NebiusNetworkServiceSchema.DeleteNetworkRequest.fromPartial({ id }),
      },
      // Cast: wrapWithOperationPolling returns WithOperationPolling which has
      // protobuf request types, but NetworkService uses simplified inputs
      // (CreateNetworkInput, etc.). The mapInput transforms above bridge the
      // gap at runtime; the cast acknowledges the type-level mismatch.
    }) as unknown as NetworkService

    // Wrap list with pagination
    const listNetworks = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawNetwork.list(req),
        (parentId, pageToken) =>
          NebiusNetworkServiceSchema.ListNetworksRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
        parentId,
      )

    const network = { ...polledNetwork, list: listNetworks }

    // --- Subnet service ---

    const rawSubnet = yield* GrpcUtils.makeGrpcService(NebiusSubnetServiceSchema.SubnetServiceClient)

    const polledSubnet = GrpcUtils.wrapWithOperationPolling(rawSubnet, {
      serviceName: 'nebius.vpc.v1.SubnetService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusSubnetServiceSchema.GetSubnetRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusSubnetServiceSchema.GetSubnetRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusSubnetServiceSchema.GetSubnetByNameRequest.fromPartial(req),
        list: (req: { parentId: string }) => NebiusSubnetServiceSchema.ListSubnetsRequest.fromPartial(req),
        listByNetwork: (req: { networkId: string }) =>
          NebiusSubnetServiceSchema.ListSubnetsByNetworkRequest.fromPartial(req),
        create: (req: CreateSubnetInput) => NebiusSubnetServiceSchema.CreateSubnetRequest.fromPartial(req),
        update: (req: UpdateSubnetInput) => NebiusSubnetServiceSchema.UpdateSubnetRequest.fromPartial(req),
        delete: (id: string) => NebiusSubnetServiceSchema.DeleteSubnetRequest.fromPartial({ id }),
      },
      // Cast: wrapWithOperationPolling returns WithOperationPolling which has
      // protobuf request types, but SubnetService uses simplified inputs
      // (CreateSubnetInput, etc.). The mapInput transforms above bridge the
      // gap at runtime; the cast acknowledges the type-level mismatch.
    }) as unknown as SubnetService

    // Wrap list with pagination
    const listSubnets = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawSubnet.list(req),
        (parentId, pageToken) =>
          NebiusSubnetServiceSchema.ListSubnetsRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
        parentId,
      )

    // Wrap listByNetwork with pagination
    const listSubnetsByNetwork = (networkId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawSubnet.listByNetwork(req),
        (networkId, pageToken) =>
          NebiusSubnetServiceSchema.ListSubnetsByNetworkRequest.fromPartial({ networkId, pageSize: 100, pageToken }),
        networkId,
      )

    // Cast: the spread merges WithOperationPolling (protobuf inputs) with
    // list/listByNetwork (which have simpler string-based inputs).
    // SubnetService uses simplified inputs throughout; verified manually.
    const subnet = {
      ...polledSubnet,
      list: listSubnets,
      listByNetwork: listSubnetsByNetwork,
    }

    // --- SecurityGroup service ---

    const rawSecurityGroup = yield* GrpcUtils.makeGrpcService(
      NebiusSecurityGroupServiceSchema.SecurityGroupServiceClient,
    )

    const polledSecurityGroup = GrpcUtils.wrapWithOperationPolling(rawSecurityGroup, {
      serviceName: 'nebius.vpc.v1.SecurityGroupService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusSecurityGroupServiceSchema.GetSecurityGroupRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusSecurityGroupServiceSchema.GetSecurityGroupRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusSecurityGroupServiceSchema.GetSecurityGroupByNameRequest.fromPartial(req),
        list: (req: { parentId: string }) =>
          NebiusSecurityGroupServiceSchema.ListSecurityGroupsRequest.fromPartial(req),
        listByNetwork: (req: { networkId: string }) =>
          NebiusSecurityGroupServiceSchema.ListSecurityGroupsByNetworkRequest.fromPartial(req),
        create: (req: CreateSecurityGroupInput) =>
          NebiusSecurityGroupServiceSchema.CreateSecurityGroupRequest.fromPartial(req),
        update: (req: UpdateSecurityGroupInput) =>
          NebiusSecurityGroupServiceSchema.UpdateSecurityGroupRequest.fromPartial(req),
        delete: (id: string) => NebiusSecurityGroupServiceSchema.DeleteSecurityGroupRequest.fromPartial({ id }),
      },
    }) as unknown as SecurityGroupService

    const listSecurityGroups = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawSecurityGroup.list(req),
        (parentId, pageToken) =>
          NebiusSecurityGroupServiceSchema.ListSecurityGroupsRequest.fromPartial({
            parentId,
            pageSize: 100,
            pageToken,
          }),
        parentId,
      )

    const listSecurityGroupsByNetwork = (networkId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawSecurityGroup.listByNetwork(req),
        (networkId, pageToken) =>
          NebiusSecurityGroupServiceSchema.ListSecurityGroupsByNetworkRequest.fromPartial({
            networkId,
            pageSize: 100,
            pageToken,
          }),
        networkId,
      )

    const securityGroup = {
      ...polledSecurityGroup,
      list: listSecurityGroups,
      listByNetwork: listSecurityGroupsByNetwork,
    }

    // --- SecurityRule service ---

    const rawSecurityRule = yield* GrpcUtils.makeGrpcService(NebiusSecurityRuleServiceSchema.SecurityRuleServiceClient)

    const polledSecurityRule = GrpcUtils.wrapWithOperationPolling(rawSecurityRule, {
      serviceName: 'nebius.vpc.v1.SecurityRuleService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusSecurityRuleServiceSchema.GetSecurityRuleRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusSecurityRuleServiceSchema.GetSecurityRuleRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusSecurityRuleServiceSchema.GetSecurityRuleByNameRequest.fromPartial(req),
        list: (req: { parentId: string }) => NebiusSecurityRuleServiceSchema.ListSecurityRulesRequest.fromPartial(req),
        create: (req: CreateSecurityRuleInput) =>
          NebiusSecurityRuleServiceSchema.CreateSecurityRuleRequest.fromPartial(req),
        update: (req: UpdateSecurityRuleInput) =>
          NebiusSecurityRuleServiceSchema.UpdateSecurityRuleRequest.fromPartial(req),
        delete: (id: string) => NebiusSecurityRuleServiceSchema.DeleteSecurityRuleRequest.fromPartial({ id }),
      },
    }) as unknown as SecurityRuleService

    const listSecurityRules = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawSecurityRule.list(req),
        (parentId, pageToken) =>
          NebiusSecurityRuleServiceSchema.ListSecurityRulesRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
        parentId,
      )

    const securityRule = { ...polledSecurityRule, list: listSecurityRules }

    // --- RouteTable service ---

    const rawRouteTable = yield* GrpcUtils.makeGrpcService(NebiusRouteTableServiceSchema.RouteTableServiceClient)

    const polledRouteTable = GrpcUtils.wrapWithOperationPolling(rawRouteTable, {
      serviceName: 'nebius.vpc.v1.RouteTableService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusRouteTableServiceSchema.GetRouteTableRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusRouteTableServiceSchema.GetRouteTableRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusRouteTableServiceSchema.GetRouteTableByNameRequest.fromPartial(req),
        list: (req: { parentId: string }) => NebiusRouteTableServiceSchema.ListRouteTablesRequest.fromPartial(req),
        listByNetwork: (req: { networkId: string }) =>
          NebiusRouteTableServiceSchema.ListRouteTablesByNetworkRequest.fromPartial(req),
        create: (req: CreateRouteTableInput) => NebiusRouteTableServiceSchema.CreateRouteTableRequest.fromPartial(req),
        update: (req: UpdateRouteTableInput) => NebiusRouteTableServiceSchema.UpdateRouteTableRequest.fromPartial(req),
        delete: (id: string) => NebiusRouteTableServiceSchema.DeleteRouteTableRequest.fromPartial({ id }),
      },
    }) as unknown as RouteTableService

    const listRouteTables = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawRouteTable.list(req),
        (parentId, pageToken) =>
          NebiusRouteTableServiceSchema.ListRouteTablesRequest.fromPartial({
            parentId,
            pageSize: 100,
            pageToken,
          }),
        parentId,
      )

    const listRouteTablesByNetwork = (networkId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawRouteTable.listByNetwork(req),
        (networkId, pageToken) =>
          NebiusRouteTableServiceSchema.ListRouteTablesByNetworkRequest.fromPartial({
            networkId,
            pageSize: 100,
            pageToken,
          }),
        networkId,
      )

    const routeTable = {
      ...polledRouteTable,
      list: listRouteTables,
      listByNetwork: listRouteTablesByNetwork,
    }

    // --- Route service ---

    const rawRoute = yield* GrpcUtils.makeGrpcService(NebiusRouteServiceSchema.RouteServiceClient)

    const polledRoute = GrpcUtils.wrapWithOperationPolling(rawRoute, {
      serviceName: 'nebius.vpc.v1.RouteService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusRouteServiceSchema.GetRouteRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusRouteServiceSchema.GetRouteRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusRouteServiceSchema.GetRouteByNameRequest.fromPartial(req),
        list: (req: { parentId: string }) => NebiusRouteServiceSchema.ListRoutesRequest.fromPartial(req),
        create: (req: CreateRouteInput) => NebiusRouteServiceSchema.CreateRouteRequest.fromPartial(req),
        update: (req: UpdateRouteInput) => NebiusRouteServiceSchema.UpdateRouteRequest.fromPartial(req),
        delete: (id: string) => NebiusRouteServiceSchema.DeleteRouteRequest.fromPartial({ id }),
      },
    }) as unknown as RouteService

    const listRoutes = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawRoute.list(req),
        (parentId, pageToken) =>
          NebiusRouteServiceSchema.ListRoutesRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
        parentId,
      )

    const route = { ...polledRoute, list: listRoutes }

    // --- Pool service ---

    const rawPool = yield* GrpcUtils.makeGrpcService(NebiusPoolServiceSchema.PoolServiceClient)

    const polledPool = GrpcUtils.wrapWithOperationPolling(rawPool, {
      serviceName: 'nebius.vpc.v1.PoolService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusPoolServiceSchema.GetPoolRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusPoolServiceSchema.GetPoolRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusPoolServiceSchema.GetPoolByNameRequest.fromPartial(req),
        list: (req: { parentId: string }) => NebiusPoolServiceSchema.ListPoolsRequest.fromPartial(req),
        listBySourcePool: (req: { poolId: string }) =>
          NebiusPoolServiceSchema.ListPoolsBySourcePoolRequest.fromPartial(req),
        create: (req: CreatePoolInput) => NebiusPoolServiceSchema.CreatePoolRequest.fromPartial(req),
        update: (req: UpdatePoolInput) => NebiusPoolServiceSchema.UpdatePoolRequest.fromPartial(req),
        delete: (id: string) => NebiusPoolServiceSchema.DeletePoolRequest.fromPartial({ id }),
      },
    }) as unknown as PoolService

    const listPools = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawPool.list(req),
        (parentId, pageToken) =>
          NebiusPoolServiceSchema.ListPoolsRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
        parentId,
      )

    const pool = { ...polledPool, list: listPools }

    // --- Allocation service ---

    const rawAllocation = yield* GrpcUtils.makeGrpcService(NebiusAllocationServiceSchema.AllocationServiceClient)

    const polledAllocation = GrpcUtils.wrapWithOperationPolling(rawAllocation, {
      serviceName: 'nebius.vpc.v1.AllocationService',
      polling: ['create', 'update'],
      forget: ['delete'],
      transport,
      getRequest: (id) => NebiusAllocationServiceSchema.GetAllocationRequest.fromPartial({ id }),
      mapInput: {
        get: (id: string) => NebiusAllocationServiceSchema.GetAllocationRequest.fromPartial({ id }),
        getByName: (req: { parentId: string; name: string }) =>
          NebiusAllocationServiceSchema.GetAllocationByNameRequest.fromPartial(req),
        list: (req: { parentId: string }) => NebiusAllocationServiceSchema.ListAllocationsRequest.fromPartial(req),
        listByPool: (req: { poolId: string }) =>
          NebiusAllocationServiceSchema.ListAllocationsByPoolRequest.fromPartial(req),
        listBySubnet: (req: { subnetId: string }) =>
          NebiusAllocationServiceSchema.ListAllocationsBySubnetRequest.fromPartial(req),
        create: (req: CreateAllocationInput) => NebiusAllocationServiceSchema.CreateAllocationRequest.fromPartial(req),
        update: (req: UpdateAllocationInput) => NebiusAllocationServiceSchema.UpdateAllocationRequest.fromPartial(req),
        delete: (id: string) => NebiusAllocationServiceSchema.DeleteAllocationRequest.fromPartial({ id }),
      },
    }) as unknown as AllocationService

    const listAllocations = (parentId: string) =>
      GrpcUtils.paginateAll(
        (req) => rawAllocation.list(req),
        (parentId, pageToken) =>
          NebiusAllocationServiceSchema.ListAllocationsRequest.fromPartial({
            parentId,
            pageSize: 100,
            pageToken,
          }),
        parentId,
      )

    const allocation = { ...polledAllocation, list: listAllocations }

    return { network, subnet, securityGroup, securityRule, routeTable, route, pool, allocation }
  }),
)
