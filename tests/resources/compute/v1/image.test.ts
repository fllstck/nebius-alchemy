import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Module from '../../../../modules/resources/compute/v1/image.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/image.schema.ts'
import * as NebiusImageSchema from '../../../../schemas/nebius/compute/v1/image.ts'
import {
  instanceIdLayer,
  mockComputeLayer,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from '../../../helpers/mocks.ts'
import { resolveProvider, runDiff, runEffect, runReconcile } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.Image', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusImage).toBeDefined()
    expect(typeof Module.NebiusImage).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusImageProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusImage.Provider, Module.NebiusImageProvider)
      expect(await runDiff(svc, { name: 'new-image', sourceDiskId: 'disk-abc123' }, { name: 'old-image', sourceDiskId: 'disk-abc123' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusImage.Provider, Module.NebiusImageProvider)
      expect(await runDiff(svc, { name: 'my-image', description: 'x', sourceDiskId: 'disk-abc123' }, { name: 'my-image', description: 'x', sourceDiskId: 'disk-abc123' })).toBeUndefined()
    })

    test('changing the (immutable) source requires replace', async () => {
      // The proto marks every `oneof source` arm IMMUTABLE — an update call with a
      // different source is rejected by the API, so plan a replace instead.
      const svc = await resolveProvider(Module.NebiusImage.Provider, Module.NebiusImageProvider)
      // Pinned name ⇒ delete-first (same identity on the next generation).
      expect(
        await runDiff(
          svc,
          { name: 'my-image', sourceStorage: { bucketName: 'b', objectName: 'o' } },
          { name: 'my-image', sourceDiskId: 'disk-abc123' },
        ),
      ).toEqual({ action: 'replace', deleteFirst: true })
    })
  })

  describe('reconcile', () => {
    const imageProto = (overrides: Partial<NebiusImageSchema.Image> = {}): NebiusImageSchema.Image => ({
      metadata: protoMetadata('image-1', 'my-image', 'project-test-1'),
      spec: NebiusImageSchema.ImageSpec.fromJSON({ type: 'NETWORK_SSD', sourceDiskId: 'disk-abc123' }),
      ...overrides,
    })

    const layerFor = (live: NebiusImageSchema.Image, updated: Array<{ spec?: NebiusImageSchema.ImageSpec }>) =>
      Effect.provide(
        Layer.mergeAll(
          mockComputeLayer({
            image: {
              get: () => Effect.succeed(live),
              update: (req: { spec?: NebiusImageSchema.ImageSpec }) => {
                updated.push(req)
                return Effect.succeed(live)
              },
            },
          }),
          stackLayer,
          testConfigLayer,
          instanceIdLayer,
        ),
      )

    const props = { name: 'my-image', sourceDiskId: 'disk-abc123', cpuArchitecture: 'AMD64' as const }

    test('a cpuArchitecture change is applied (regression: it planned an update that wrote nothing)', async () => {
      const svc = await resolveProvider(Module.NebiusImage.Provider, Module.NebiusImageProvider)
      const updated: Array<{ spec?: NebiusImageSchema.ImageSpec }> = []

      const live = imageProto({
        spec: NebiusImageSchema.ImageSpec.fromJSON({ sourceDiskId: 'disk-abc123', cpuArchitecture: 'ARM64' }),
      })
      await runReconcile(svc, props, { id: 'image-1' }, undefined, layerFor(live, updated))

      expect(updated).toHaveLength(1)
    })

    test('a recommendedPlatforms change is applied', async () => {
      const svc = await resolveProvider(Module.NebiusImage.Provider, Module.NebiusImageProvider)
      const updated: Array<{ spec?: NebiusImageSchema.ImageSpec }> = []

      const live = imageProto({
        spec: NebiusImageSchema.ImageSpec.fromJSON({ sourceDiskId: 'disk-abc123', recommendedPlatforms: ['gpu-h200-sxm'] }),
      })
      await runReconcile(
        svc,
        { ...props, recommendedPlatforms: ['cpu-d3'] },
        { id: 'image-1' },
        undefined,
        layerFor(live, updated),
      )

      expect(updated).toHaveLength(1)
    })

    test('an unchanged image is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusImage.Provider, Module.NebiusImageProvider)
      const updated: Array<{ spec?: NebiusImageSchema.ImageSpec }> = []

      const live = imageProto({
        spec: NebiusImageSchema.ImageSpec.fromJSON({ sourceDiskId: 'disk-abc123', cpuArchitecture: 'AMD64' }),
      })
      await runReconcile(svc, props, { id: 'image-1' }, undefined, layerFor(live, updated))

      expect(updated).toHaveLength(0)
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({ name: 'my-image', description: 'a golden image', sourceDiskId: 'disk-abc123' }),
      )
      expect(result.name).toBe('my-image')
    })

    test('rejects props without a source disk or snapshot', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({ name: 'my-image' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({ name: 'My Image!' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    // ── bucket source (Task 7b schema-audit gaps) ─────────────────────────
    // `source_storage` was in the generated ImageSpec but absent from the props
    // schema, so an image could not be created from a bucket object at all.
    test('accepts a bucket object as the create source', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({
          name: 'my-image',
          sourceStorage: { bucketName: 'my-bucket', objectName: 'images/base.qcow2' },
        }),
      )
      expect(result.sourceStorage?.objectName).toBe('images/base.qcow2')
    })

    test('rejects a bucket source combined with a disk source (oneof is required)', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({
          name: 'my-image',
          sourceDiskId: 'disk-abc123',
          sourceStorage: { bucketName: 'my-bucket', objectName: 'images/base.qcow2' },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects a disk source combined with a snapshot source', async () => {
      const result = await runEffect(
        SchemaModule.validateImageProps({
          name: 'my-image',
          sourceDiskId: 'disk-abc123',
          sourceDiskSnapshotId: 'disksnapshot-abc123',
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('serialises the bucket source onto the wire through ImageSpec.fromJSON', () => {
      const spec = NebiusImageSchema.ImageSpec.fromJSON({
        sourceStorage: { bucketName: 'my-bucket', objectName: 'images/base.qcow2' },
      })
      expect(spec.sourceStorage?.bucketName).toBe('my-bucket')
      expect(spec.sourceStorage?.objectName).toBe('images/base.qcow2')
    })
  })
})
