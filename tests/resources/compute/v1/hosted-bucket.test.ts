/**
 * `ensureUserBucketGrants` — the user-supplied assets bucket region check +
 * prefix-scoped policy-rule grant, with a MOCKED StorageGrpcService (no cloud,
 * no SLOW_TESTS). Verifies the `BucketRegionMismatch` tagged error is thrown
 * for a wrong-region bucket and is `catchTag`-able, and that a same-region
 * bucket gets the read-only fetch + upload-editor policy rules appended.
 */
import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Layer from 'effect/Layer'
import * as StorageGrpc from '../../../../modules/api-client/storage.ts'
import {
  ensureUserBucketGrants,
  BucketRegionMismatch,
  type NebiusHostedBinding,
} from '../../../../modules/resources/compute/v1/hosted.ts'

/** A mocked StorageGrpcService recording bucket.update calls. */
// oxlint-disable-next-line no-explicit-any — test mock: partial protobuf-shaped bucket
const mockStorage = (region: string, existingRules: any[] = []) => {
  const updates: Array<{ metadata: unknown; spec: unknown }> = []
  const layer = Layer.succeed(
    StorageGrpc.StorageGrpcService,
    {
      bucket: {
        getByName: () =>
          Effect.succeed({
            metadata: { id: 'bucket-1', name: 'shared-bucket', resourceVersion: 1 },
            spec: { bucketPolicy: { rules: existingRules } },
            status: { region },
          }),
        update: (request: { metadata: unknown; spec: unknown }) => {
          updates.push({ metadata: request.metadata, spec: request.spec })
          return Effect.succeed({ metadata: { id: 'bucket-1' } })
        },
      },
    } as never,
  )
  return { layer, updates }
}

const config = {
  bucketName: 'shared-bucket',
  assetPrefix: 'compute/api-runtime-abc',
  fetchGroupId: 'group-fetch',
  hostGroupId: 'group-upload',
}

describe('hosted ensureUserBucketGrants', () => {
  test('rejects a bucket in a different region with BucketRegionMismatch', async () => {
    const { layer } = mockStorage('eu-west1')
    const error = await Effect.runPromise(
      ensureUserBucketGrants({ ...config, region: 'eu-north1' }).pipe(
        Effect.flip,
        Effect.provide(layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_PROJECT_ID: 'project-1' }))),
      ),
    )
    expect(error._tag).toBe('BucketRegionMismatch')
    if (error._tag === 'BucketRegionMismatch') {
      expect(error.bucketName).toBe('shared-bucket')
      expect(error.bucketRegion).toBe('eu-west1')
      expect(error.stackRegion).toBe('eu-north1')
    }
  })

  test('BucketRegionMismatch is catchTag-able', async () => {
    const { layer } = mockStorage('eu-west1')
    const caught = await Effect.runPromise(
      ensureUserBucketGrants({ ...config, region: 'eu-north1' }).pipe(
        Effect.catchTag('BucketRegionMismatch', (error: BucketRegionMismatch) =>
          Effect.succeed(`caught ${error.bucketRegion}`),
        ),
        Effect.provide(layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_PROJECT_ID: 'project-1' }))),
      ),
    )
    expect(caught).toBe('caught eu-west1')
  })

  test('appends prefix-scoped viewer + editor policy rules to a same-region bucket, preserving existing rules', async () => {
    const existing = [{ paths: ['user/data/*'], roles: ['storage.viewer'], groupId: 'group-user' }]
    const { layer, updates } = mockStorage('eu-north1', existing)
    await Effect.runPromise(
      ensureUserBucketGrants({ ...config, region: 'eu-north1' }).pipe(
        Effect.provide(layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_PROJECT_ID: 'project-1' }))),
      ),
    )
    expect(updates).toHaveLength(1)
    const spec = updates[0]!.spec as { bucketPolicy?: { rules?: Array<NebiusHostedBinding & { paths?: string[]; roles?: string[]; groupId?: string }> } }
    const rules = spec.bucketPolicy?.rules ?? []
    // Existing rule preserved.
    expect(rules.some((rule) => rule.groupId === 'group-user')).toBe(true)
    // Prefix-scoped rules appended: fetch key = read-only viewer, upload = editor.
    expect(rules).toContainEqual({
      paths: ['compute/api-runtime-abc/*'],
      roles: ['storage.viewer'],
      groupId: 'group-fetch',
    })
    expect(rules).toContainEqual({
      paths: ['compute/api-runtime-abc/*'],
      roles: ['storage.editor'],
      groupId: 'group-upload',
    })
  })

  test('does not duplicate an already-granted rule', async () => {
    const existing = [{ paths: ['compute/api-runtime-abc/*'], roles: ['storage.viewer'], groupId: 'group-fetch' }]
    const { layer, updates } = mockStorage('eu-north1', existing)
    await Effect.runPromise(
      ensureUserBucketGrants({ ...config, region: 'eu-north1' }).pipe(
        Effect.provide(layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_PROJECT_ID: 'project-1' }))),
      ),
    )
    const spec = updates[0]!.spec as { bucketPolicy?: { rules?: unknown[] } }
    const rules = spec.bucketPolicy?.rules ?? []
    expect(rules.filter((rule) => (rule as { groupId?: string }).groupId === 'group-fetch')).toHaveLength(1)
  })
})
