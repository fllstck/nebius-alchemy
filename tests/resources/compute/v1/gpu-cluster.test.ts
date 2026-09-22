import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import * as Module from '../../../../modules/resources/compute/v1/gpu-cluster.ts'
import * as SchemaModule from '../../../../modules/resources/compute/v1/gpu-cluster.schema.ts'
import * as ComputeSchema from '../../../../schemas/nebius/compute/v1/gpu_cluster.ts'
import * as ComputeGrpc from '../../../../modules/api-client/compute.ts'
import {
  fakeSession,
  instanceIdLayer,
  mockComputeLayer,
  notFoundError,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from '../../../helpers/mocks.ts'
import {
  resolveProvider,
  runDelete,
  runDeleteExpectingError,
  runDiff,
  runEffect,
  runReconcile,
} from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

const validProps = { infinibandFabric: 'fabric-eu-north1-a' }

const clusterProto = (overrides: Partial<ComputeSchema.GpuCluster> = {}): ComputeSchema.GpuCluster => ({
  metadata: protoMetadata('gpucluster-1', 'my-cluster', 'project-test-1'),
  spec: { infinibandFabric: 'fabric-eu-north1-a' },
  status: { instances: [], reconciling: false },
  ...overrides,
})

describe('Nebius.compute.v1.GpuCluster', () => {
  test('constructor is defined', () => {
    expect(Module.NebiusGpuCluster).toBeDefined()
    expect(typeof Module.NebiusGpuCluster).toBe('function')
  })

  test('provider is defined', () => {
    expect(Module.NebiusGpuClusterProvider).toBeDefined()
  })

  describe('diff', () => {

    test('a fabric change replaces; a generated name stays create-first', async () => {
      const svc = await resolveProvider(Module.NebiusGpuCluster.Provider, Module.NebiusGpuClusterProvider)
      expect(
        await runDiff(svc, { ...validProps, infinibandFabric: 'fabric-b' }, { ...validProps, infinibandFabric: 'fabric-a' }),
      ).toEqual({ action: 'replace' })
    })

    test('a fabric change with a pinned name is delete-first', async () => {
      const svc = await resolveProvider(Module.NebiusGpuCluster.Provider, Module.NebiusGpuClusterProvider)
      expect(
        await runDiff(
          svc,
          { ...validProps, name: 'training', infinibandFabric: 'fabric-b' },
          { ...validProps, name: 'training', infinibandFabric: 'fabric-a' },
        ),
      ).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('a name change is create-first', async () => {
      const svc = await resolveProvider(Module.NebiusGpuCluster.Provider, Module.NebiusGpuClusterProvider)
      expect(await runDiff(svc, { ...validProps, name: 'new' }, { ...validProps, name: 'old' })).toEqual({
        action: 'replace',
      })
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(SchemaModule.validateGpuClusterProps(validProps))
      expect(result.infinibandFabric).toBe('fabric-eu-north1-a')
    })

    test('rejects an empty fabric (the API would reject it, and the message says where to get one)', async () => {
      const result = await runEffect(SchemaModule.validateGpuClusterProps({ infinibandFabric: '  ' }).pipe(Effect.flip))
      expect(result._tag).toBe('PropsValidationError')
      expect(String(result.message)).toContain('infinibandFabric is required')
    })

    test('rejects a non-DNS name', async () => {
      const result = await runEffect(
        SchemaModule.validateGpuClusterProps({ ...validProps, name: 'My Cluster!' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('plan-time validation fails the diff before any API call', async () => {
      const svc = await resolveProvider(Module.NebiusGpuCluster.Provider, Module.NebiusGpuClusterProvider)
      // `diff` runs props validation first, so a bad fabric never reaches the API.
      // A plain try/catch rather than `expect(...).rejects`: bun's matcher reads as
      // a non-thenable to the linter.
      let message = ''
      try {
        await runDiff(svc, { infinibandFabric: '   ' }, validProps)
      } catch (error) {
        message = String(error)
      }
      expect(message).toContain('infinibandFabric is required')
    })
  })

  describe('reconcile', () => {
    test('creates the cluster with internal tags and the fabric from props', async () => {
      const svc = await resolveProvider(Module.NebiusGpuCluster.Provider, Module.NebiusGpuClusterProvider)
      const created: Array<{ metadata?: { name?: string; labels?: Record<string, string> }; spec?: unknown }> = []

      const layer = mockComputeLayer({
        gpuCluster: {
          get: () => Effect.succeed(clusterProto()),
          create: (req: { metadata?: { name?: string }; spec?: unknown }) => {
            created.push(req)
            return Effect.succeed(clusterProto())
          },
        },
      })

      const attrs = await runReconcile(
        svc,
        validProps,
        undefined,
        undefined,
        Effect.provide(Layer.mergeAll(layer, stackLayer, testConfigLayer, instanceIdLayer)),
      )

      expect(created).toHaveLength(1)
      expect(created[0]!.spec).toEqual({ infinibandFabric: 'fabric-eu-north1-a' })
      // Ownership tags are always present (the untagged case is `Unowned`).
      expect(Object.keys(created[0]!.metadata!.labels ?? {}).length).toBeGreaterThan(0)
      expect(attrs.id).toBe('gpucluster-1')
    })
  })

  describe('delete (member guard)', () => {
    const deleteInput = {
      id: 'Cluster',
      fqn: 'Cluster',
      instanceId: 'inst',
      olds: { infinibandFabric: 'fabric-a' },
      output: { id: 'gpucluster-1' },
      session: fakeSession,
      bindings: [],
    }

    test('refuses to delete a cluster that still has instances, naming them', async () => {
      const svc = await resolveProvider(Module.NebiusGpuCluster.Provider, Module.NebiusGpuClusterProvider)
      let deleted = false
      const layer = mockComputeLayer({
        gpuCluster: {
          get: () =>
            Effect.succeed(
              clusterProto({
                metadata: protoMetadata('gpucluster-1', 'vc-a', 'project-test-1'),
                status: { instances: ['computeinstance-e00abc', 'computeinstance-e00def'], reconciling: false },
              }),
            ),
          delete: () => {
            deleted = true
            return Effect.void
          },
        },
      })

      const error = await runDeleteExpectingError(svc, deleteInput.output, deleteInput.olds, Effect.provide(layer))

      expect(deleted).toBe(false)
      expect(error._tag).toBe('GpuClusterNotEmpty')
      expect(error.instances).toEqual(['computeinstance-e00abc', 'computeinstance-e00def'])
      expect(error.message).toContain('computeinstance-e00abc')
      expect(error.message).toContain('create-only')
    })

    test('deletes an empty cluster', async () => {
      const svc = await resolveProvider(Module.NebiusGpuCluster.Provider, Module.NebiusGpuClusterProvider)
      const deletedIds: string[] = []
      const layer = mockComputeLayer({
        gpuCluster: {
          get: () => Effect.succeed(clusterProto()),
          delete: (id: string) => {
            deletedIds.push(id)
            return Effect.void
          },
        },
      })

      await runDelete(svc, deleteInput.output, deleteInput.olds, Effect.provide(layer))
      expect(deletedIds).toEqual(['gpucluster-1'])
    })

    test('is idempotent when the cluster is already gone', async () => {
      const svc = await resolveProvider(Module.NebiusGpuCluster.Provider, Module.NebiusGpuClusterProvider)
      let deleted = false
      const layer = mockComputeLayer({
        gpuCluster: {
          get: () => Effect.fail(notFoundError()),
          delete: () => {
            deleted = true
            return Effect.void
          },
        },
      })

      await runDelete(svc, deleteInput.output, deleteInput.olds, Effect.provide(layer))
      expect(deleted).toBe(false)
    })
  })

  test('the api-client exposes the gpuCluster service', async () => {
    const svc = await runEffect(Effect.gen(function* () {
      return yield* ComputeGrpc.ComputeGrpcService
    }).pipe(Effect.provide(mockComputeLayer({ gpuCluster: { get: () => Effect.succeed(clusterProto()) } }))))
    expect(typeof svc.gpuCluster.get).toBe('function')
  })
})
