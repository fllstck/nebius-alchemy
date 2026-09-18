import * as Alchemy from 'alchemy'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as IamGrpc from '../../../api-client/iam.ts'
import * as VpcGrpc from '../../../api-client/vpc.ts'
import * as Validation from '../../validation.ts'
import * as Network from './network.ts'
import * as Subnet from './subnet.ts'
import * as SecurityGroup from './security-group.ts'
import * as RouteTable from './route-table.ts'
import * as Pool from './pool.ts'
import { resolveTenantId } from '../../shared/tenant.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ── Network ───────────────────────────────────────────────────────────────

export const GetNetwork = Alchemy.Action(
  'Nebius.vpc.actions.GetNetwork',
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const defaultProjectId = yield* Config.String('NEBIUS_PROJECT_ID')
    return ({ name, parentId }: { name: string; parentId?: IamV2Ids.ProjectId }) =>
      Effect.gen(function* () {
        const pid = parentId ?? defaultProjectId
        const result = yield* vpc.network
          .getByName({ parentId: pid, name })
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
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
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = parentId ? [parentId] : (yield* iam.project.list(tenantId)).map((p) => p.metadata!.id)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          vpc.network.list(pid).pipe(
            Effect.map((items) => items.map((raw) => Network.toFriendlyAttributes(raw))),
            Effect.catch(() => Effect.succeed([] as readonly ReturnType<typeof Network.toFriendlyAttributes>[])),
          ),
        )
        return results.flat()
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
        const result = yield* vpc.subnet
          .getByName({ parentId: pid, name })
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
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
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = parentId ? [parentId] : (yield* iam.project.list(tenantId)).map((p) => p.metadata!.id)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          vpc.subnet.list(pid).pipe(
            Effect.map((items) => items.map((raw) => Subnet.toFriendlyAttributes(raw))),
            Effect.catch(() => Effect.succeed([] as readonly ReturnType<typeof Subnet.toFriendlyAttributes>[])),
          ),
        )
        return results.flat()
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
        const result = yield* vpc.securityGroup
          .getByName({ parentId: pid, name })
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
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
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = parentId ? [parentId] : (yield* iam.project.list(tenantId)).map((p) => p.metadata!.id)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          vpc.securityGroup.list(pid).pipe(
            Effect.map((items) => items.map((raw) => SecurityGroup.toFriendlyAttributes(raw))),
            Effect.catch(() => Effect.succeed([] as readonly ReturnType<typeof SecurityGroup.toFriendlyAttributes>[])),
          ),
        )
        return results.flat()
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
        const result = yield* vpc.routeTable
          .getByName({ parentId: pid, name })
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
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
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = parentId ? [parentId] : (yield* iam.project.list(tenantId)).map((p) => p.metadata!.id)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          vpc.routeTable.list(pid).pipe(
            Effect.map((items) => items.map((raw) => RouteTable.toFriendlyAttributes(raw))),
            Effect.catch(() => Effect.succeed([] as readonly ReturnType<typeof RouteTable.toFriendlyAttributes>[])),
          ),
        )
        return results.flat()
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
        const result = yield* vpc.pool
          .getByName({ parentId: pid, name })
          .pipe(Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed(undefined) : Effect.fail(e))))
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
    const iam = yield* IamGrpc.IamGrpcService
    const tenantId = yield* resolveTenantId()
    return ({ parentId }: { parentId?: IamV2Ids.ProjectId } = {}) =>
      Effect.gen(function* () {
        const parentIds = parentId ? [parentId] : (yield* iam.project.list(tenantId)).map((p) => p.metadata!.id)
        const results = yield* Effect.forEach(parentIds, (pid) =>
          vpc.pool.list(pid).pipe(
            Effect.map((items) => items.map((raw) => Pool.toFriendlyAttributes(raw))),
            Effect.catch(() => Effect.succeed([] as readonly ReturnType<typeof Pool.toFriendlyAttributes>[])),
          ),
        )
        return results.flat()
      })
  }),
)
