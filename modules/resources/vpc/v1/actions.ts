import * as Alchemy from 'alchemy'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as Validation from '../../validation.ts'
import * as Network from './network.ts'
import * as Subnet from './subnet.ts'
import * as SecurityGroup from './security-group.ts'
import * as RouteTable from './route-table.ts'
import * as Pool from './pool.ts'
import { forEachParent, resolveParentIds } from '../../shared/fan-out.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'
import { getOrUndefined } from '../../shared/not-found.ts'

// ── Network ───────────────────────────────────────────────────────────────

export const GetNetwork = Alchemy.Action(
  'Nebius.vpc.actions.GetNetwork',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const defaultProjectId = yield* Config.String('NEBIUS_PROJECT_ID')
    return ({ name, parentId }: { name: string; parentId?: IamV2Ids.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* getOrUndefined(vpc.network.getByName({ parentId: pid, name }))
        if (!result) {
          return yield* Effect.fail(
            new Validation.ResourceNotFoundError({
              resourceType: 'network',
              name,
              parent: pid,
              message: `No network named "${name}" found in project ${pid}`,
            }),
          )
        }
        return Network.toFriendlyAttributes(result)
      })
  }),
)

export const ListNetworks = Alchemy.Action(
  'Nebius.vpc.actions.ListNetworks',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = yield* resolveParentIds(parentId)
        return yield* forEachParent(
          parentIds,
          (pid) => `networks in project ${pid}`,
          (pid) =>
            vpc.network.list(pid).pipe(Effect.map((items) => items.map((raw) => Network.toFriendlyAttributes(raw)))),
        )
      })
  }),
)

// ── Subnet ────────────────────────────────────────────────────────────────

export const GetSubnet = Alchemy.Action(
  'Nebius.vpc.actions.GetSubnet',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const defaultProjectId = yield* Config.String('NEBIUS_PROJECT_ID')
    return ({ name, parentId }: { name: string; parentId?: IamV2Ids.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* getOrUndefined(vpc.subnet.getByName({ parentId: pid, name }))
        if (!result) {
          return yield* Effect.fail(
            new Validation.ResourceNotFoundError({
              resourceType: 'subnet',
              name,
              parent: pid,
              message: `No subnet named "${name}" found in project ${pid}`,
            }),
          )
        }
        return Subnet.toFriendlyAttributes(result)
      })
  }),
)

export const ListSubnets = Alchemy.Action(
  'Nebius.vpc.actions.ListSubnets',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = yield* resolveParentIds(parentId)
        return yield* forEachParent(
          parentIds,
          (pid) => `subnets in project ${pid}`,
          (pid) =>
            vpc.subnet.list(pid).pipe(Effect.map((items) => items.map((raw) => Subnet.toFriendlyAttributes(raw)))),
        )
      })
  }),
)

// ── SecurityGroup ─────────────────────────────────────────────────────────

export const GetSecurityGroup = Alchemy.Action(
  'Nebius.vpc.actions.GetSecurityGroup',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const defaultProjectId = yield* Config.String('NEBIUS_PROJECT_ID')
    return ({ name, parentId }: { name: string; parentId?: IamV2Ids.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* getOrUndefined(vpc.securityGroup.getByName({ parentId: pid, name }))
        if (!result) {
          return yield* Effect.fail(
            new Validation.ResourceNotFoundError({
              resourceType: 'security group',
              name,
              parent: pid,
              message: `No security group named "${name}" found in project ${pid}`,
            }),
          )
        }
        return SecurityGroup.toFriendlyAttributes(result)
      })
  }),
)

export const ListSecurityGroups = Alchemy.Action(
  'Nebius.vpc.actions.ListSecurityGroups',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = yield* resolveParentIds(parentId)
        return yield* forEachParent(
          parentIds,
          (pid) => `security groups in project ${pid}`,
          (pid) =>
            vpc.securityGroup
              .list(pid)
              .pipe(Effect.map((items) => items.map((raw) => SecurityGroup.toFriendlyAttributes(raw)))),
        )
      })
  }),
)

// ── RouteTable ────────────────────────────────────────────────────────────

export const GetRouteTable = Alchemy.Action(
  'Nebius.vpc.actions.GetRouteTable',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const defaultProjectId = yield* Config.String('NEBIUS_PROJECT_ID')
    return ({ name, parentId }: { name: string; parentId?: IamV2Ids.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* getOrUndefined(vpc.routeTable.getByName({ parentId: pid, name }))
        if (!result) {
          return yield* Effect.fail(
            new Validation.ResourceNotFoundError({
              resourceType: 'route table',
              name,
              parent: pid,
              message: `No route table named "${name}" found in project ${pid}`,
            }),
          )
        }
        return RouteTable.toFriendlyAttributes(result)
      })
  }),
)

export const ListRouteTables = Alchemy.Action(
  'Nebius.vpc.actions.ListRouteTables',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = yield* resolveParentIds(parentId)
        return yield* forEachParent(
          parentIds,
          (pid) => `route tables in project ${pid}`,
          (pid) =>
            vpc.routeTable
              .list(pid)
              .pipe(Effect.map((items) => items.map((raw) => RouteTable.toFriendlyAttributes(raw)))),
        )
      })
  }),
)

// ── Pool ──────────────────────────────────────────────────────────────────

export const GetPool = Alchemy.Action(
  'Nebius.vpc.actions.GetPool',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const defaultProjectId = yield* Config.String('NEBIUS_PROJECT_ID')
    return ({ name, parentId }: { name: string; parentId?: IamV2Ids.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* getOrUndefined(vpc.pool.getByName({ parentId: pid, name }))
        if (!result) {
          return yield* Effect.fail(
            new Validation.ResourceNotFoundError({
              resourceType: 'pool',
              name,
              parent: pid,
              message: `No pool named "${name}" found in project ${pid}`,
            }),
          )
        }
        return Pool.toFriendlyAttributes(result)
      })
  }),
)

export const ListPools = Alchemy.Action(
  'Nebius.vpc.actions.ListPools',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = yield* resolveParentIds(parentId)
        return yield* forEachParent(
          parentIds,
          (pid) => `pools in project ${pid}`,
          (pid) => vpc.pool.list(pid).pipe(Effect.map((items) => items.map((raw) => Pool.toFriendlyAttributes(raw)))),
        )
      })
  }),
)
