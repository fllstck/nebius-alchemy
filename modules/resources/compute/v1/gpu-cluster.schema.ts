import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// Domain validations
// ---------------------------------------------------------------------------

/**
 * `infinibandFabric` is a physical-fabric identifier with no format rule we
 * could enforce locally — only non-emptiness. The API rejects an empty value,
 * and the usable values are not discoverable through any RPC in the generated
 * surface (the only place a fabric is named is `capacity/v1` resource advice,
 * which is not implemented yet — see TASKS.md §"capacity discovery"), so the
 * message says where to find one instead of leaving the user with a raw
 * INVALID_ARGUMENT.
 */
const fabricValid = Schema.makeFilter((value: string) =>
  value.trim().length > 0
    ? undefined
    : 'infinibandFabric is required — pass the InfiniBand fabric id of the target region (Nebius console → GPU clusters, or `nebius capacity resource-advice list`)',
)

// ---------------------------------------------------------------------------
// GpuCluster Props (user input)
// ---------------------------------------------------------------------------

export const GpuClusterPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * The identifier of the physical InfiniBand fabric to connect GPU instances
   * to. Immutable after creation — changing it replaces the cluster (see the
   * provider's `diff`).
   */
  infinibandFabric: Schema.String.check(fabricValid),
})

export type GpuClusterProps = typeof GpuClusterPropsSchema.Type

export const validateGpuClusterProps = Validation.makeValidateProps(GpuClusterPropsSchema)

// ---------------------------------------------------------------------------
// GpuCluster Attributes (output)
// ---------------------------------------------------------------------------

export const GpuClusterAttributesSchema = Schema.Struct({
  id: Ids.GpuClusterId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  infinibandFabric: Schema.String,
  /**
   * Instances currently attached (read-only). Membership is declared on the
   * Instance (`gpuCluster.id`) — the cluster itself has no members field, so
   * this is the only way to see it.
   */
  instances: Schema.optional(Schema.Array(Ids.InstanceId)),
  /** Whether an operation is in flight on the cluster. */
  reconciling: Schema.optional(Schema.Boolean),
  /** InfiniBand topology path per attached instance, when the platform reports it. */
  infinibandTopologyPath: Schema.optional(
    Schema.Struct({
      instances: Schema.Array(
        Schema.Struct({
          instanceId: Ids.InstanceId,
          path: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
})

export type GpuClusterAttributes = typeof GpuClusterAttributesSchema.Type
