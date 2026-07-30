import * as Schema from 'effect/Schema'

/** Branded ID for VPC Network resources. */
export const NetworkId = Schema.String.pipe(Schema.brand('NetworkId'))
export type NetworkId = typeof NetworkId.Type

/** Branded ID for VPC Subnet resources. */
export const SubnetId = Schema.String.pipe(Schema.brand('SubnetId'))
export type SubnetId = typeof SubnetId.Type

/** Branded ID for VPC RouteTable resources. */
export const RouteTableId = Schema.String.pipe(Schema.brand('RouteTableId'))
export type RouteTableId = typeof RouteTableId.Type

/** Branded ID for VPC SecurityGroup resources. */
export const SecurityGroupId = Schema.String.pipe(Schema.brand('SecurityGroupId'))
export type SecurityGroupId = typeof SecurityGroupId.Type

/** Branded ID for VPC Pool resources. */
export const PoolId = Schema.String.pipe(Schema.brand('PoolId'))
export type PoolId = typeof PoolId.Type

/** Branded ID for VPC Allocation resources. */
export const AllocationId = Schema.String.pipe(Schema.brand('AllocationId'))
export type AllocationId = typeof AllocationId.Type

/** Branded ID for VPC Route resources. */
export const RouteId = Schema.String.pipe(Schema.brand('RouteId'))
export type RouteId = typeof RouteId.Type
