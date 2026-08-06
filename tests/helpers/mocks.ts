/**
 * Shared mocks for behavioral unit tests of resource providers.
 *
 * Providers under test yield gRPC service tags (e.g. `IamGrpcService`,
 * `QuotasGrpcService`) plus Alchemy's `Stack`/`Stage` services (for ownership
 * tags) and read config from `ConfigProvider`. These helpers build minimal
 * structural fakes for all of them so lifecycle operations (`reconcile`,
 * `precreate`, `read`) can be exercised without any network access.
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ConfigProvider from 'effect/ConfigProvider'
import Long from 'long'

import * as Iam from '../../modules/api-client/iam.ts'
import * as Quotas from '../../modules/api-client/quotas.ts'
import { Stack } from 'alchemy/Stack'
import { Stage } from 'alchemy/Stage'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** ConfigProvider with the env vars resource providers read. */
export const testConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    NEBIUS_PROJECT_ID: 'project-test-1',
    NEBIUS_TENANT_ID: 'tenant-test-1',
  }),
)

// ---------------------------------------------------------------------------
// Stack / Stage (required by createInternalTags / hasAlchemyTags)
// ---------------------------------------------------------------------------

/** Minimal Stack + Stage services so ownership tagging works. */
export const stackLayer = Layer.mergeAll(
  Layer.succeed(
    Stack,
    Stack.of({
      name: 'test-stack',
      stage: 'test',
      resources: {},
      bindings: {},
      actions: {},
    }),
  ),
  Layer.succeed(Stage, 'test'),
)

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Structural fake for the plan-status session passed to reconcile/precreate. */
export const fakeSession = {
  note: (_message: string) => Effect.void,
  // oxlint-disable-next-line no-explicit-any — structural test mock
} as any

// ---------------------------------------------------------------------------
// gRPC service mocks
// ---------------------------------------------------------------------------

/**
 * Build an IamGrpcService layer with only the sub-services under test.
 * `unknown` on purpose: structural mocks don't reproduce the full proto
 * types — a missing method surfaces as a runtime TypeError, failing the test.
 */
export const mockIamLayer = (partial: unknown) =>
  Layer.succeed(Iam.IamGrpcService, partial as Iam.IamGrpcServiceShape)

/** Build a QuotasGrpcService layer with only the sub-services under test. */
export const mockQuotasLayer = (partial: unknown) =>
  Layer.succeed(Quotas.QuotasGrpcService, partial as Quotas.QuotasGrpcServiceShape)

// ---------------------------------------------------------------------------
// Proto fixtures
// ---------------------------------------------------------------------------

export const ZERO_LONG = Long.fromNumber(0)

/** Minimal proto ResourceMetadata for mock API responses. */
export const protoMetadata = (id: string, name: string, parentId: string, labels: Record<string, string> = {}) => ({
  id,
  parentId,
  name,
  resourceVersion: ZERO_LONG,
  labels,
})
