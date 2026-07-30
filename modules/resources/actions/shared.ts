import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as IamGrpc from '../../api-client/iam'

/**
 * Resolve all project IDs under the configured tenant.
 * Used by list-all actions to fan out across projects.
 */
export const listProjectIds = Effect.gen(function* () {
  const iam = yield* IamGrpc.IamGrpcService
  const tenantId = yield* Config.string('NEBIUS_TENANT_ID')
  const projects = yield* iam.project.list(tenantId)
  return projects.map((p) => p.metadata!.id)
})
