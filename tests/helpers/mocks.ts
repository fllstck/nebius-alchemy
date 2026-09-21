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
import * as Compute from '../../modules/api-client/compute.ts'
import * as Storage from '../../modules/api-client/storage.ts'
import * as Capacity from '../../modules/api-client/capacity.ts'
import * as Dns from '../../modules/api-client/dns.ts'
import * as Vpc from '../../modules/api-client/vpc.ts'
import * as Kms from '../../modules/api-client/kms.ts'
import * as Mysterybox from '../../modules/api-client/mysterybox.ts'
import { GrpcError } from '../../modules/api-client/grpc-utils.ts'
import { Stack } from 'alchemy/Stack'
import { Stage } from 'alchemy/Stage'
import { InstanceId } from 'alchemy/InstanceId'

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

/**
 * alchemy's per-resource instance id. `createPhysicalName` seeds its random
 * suffix from it, so any lifecycle that mints a generated name needs it — the
 * engine provides it in real runs (`Apply.ts`), tests must do so explicitly.
 */
export const instanceIdLayer = Layer.succeed(InstanceId, '0f1e2d3c4b5a69788796a5b4c3d2e1f0')

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Structural fake for the plan-status session passed to reconcile/precreate. */
export const fakeSession = {
  note: (_message: string) => Effect.void,
  // oxlint-disable-next-line no-explicit-any — structural test mock
} as any

/**
 * A plan-status session that **records** what a lifecycle narrated.
 *
 * `session.note` is a provider's only progress channel, and some factory behaviour
 * *is* the narration: the dependency-wait note must fire exactly once, and the labels
 * and attempt counts inside notes are user-facing. `fakeSession` discards them, which
 * is why a mutation-testing run (`bun run mutation`, 2026-09-21) found the whole
 * note-writing branch of `runDeleteWithProgress` and `makeCrudDelete` unobservable.
 *
 * Usage — pass `session` to the lifecycle under test, then assert on `messages()`:
 *
 *   const { session, messages } = recordingSession()
 *   await runPromise(runDeleteWithProgress({ ...args, session }))
 *   expect(messages()).toHaveLength(1)
 */
export const recordingSession = () => {
  const messages: Array<string> = []
  return {
    // oxlint-disable-next-line no-explicit-any — structural test mock (see fakeSession)
    session: {
      note: (message: string) =>
        Effect.sync(() => {
          messages.push(message)
        }),
    } as any,
    /** Everything narrated so far, in order. */
    messages: (): ReadonlyArray<string> => messages,
  }
}

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

/**
 * Build a ComputeGrpcService layer with only the sub-services under test.
 * `unknown` on purpose — see {@link mockIamLayer}.
 */
export const mockComputeLayer = (partial: unknown) =>
  Layer.succeed(Compute.ComputeGrpcService, partial as Compute.ComputeGrpcServiceShape)

/** Build a StorageGrpcService layer with only the sub-services under test. */
export const mockStorageLayer = (partial: unknown) =>
  Layer.succeed(Storage.StorageGrpcService, partial as Storage.StorageGrpcServiceShape)

/** Build a CapacityGrpcService layer with only the sub-services under test. */
export const mockCapacityLayer = (partial: unknown) =>
  Layer.succeed(Capacity.CapacityGrpcService, partial as Capacity.CapacityGrpcServiceShape)

/** Build a DnsGrpcService layer with only the sub-services under test. */
export const mockDnsLayer = (partial: unknown) =>
  Layer.succeed(Dns.DnsGrpcService, partial as Dns.DnsGrpcServiceShape)

/** Build a VpcGrpcService layer with only the sub-services under test. */
export const mockVpcLayer = (partial: unknown) =>
  Layer.succeed(Vpc.VpcGrpcService, partial as Vpc.VpcGrpcServiceShape)

/** Build a KmsGrpcService layer with only the sub-services under test. */
export const mockKmsLayer = (partial: unknown) =>
  Layer.succeed(Kms.KmsGrpcService, partial as Kms.KmsGrpcServiceShape)

/** Build a MysteryBoxGrpcService layer with only the sub-services under test. */
export const mockMysteryboxLayer = (partial: unknown) =>
  Layer.succeed(Mysterybox.MysteryBoxGrpcService, partial as Mysterybox.MysteryBoxGrpcServiceShape)

/** A gRPC NOT_FOUND (code 5), as the API returns for a deleted resource. */
export const notFoundError = () => new GrpcError({ code: 5, message: 'not found', details: '' })

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
