import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Module from '../../../../modules/resources/ai/v1/job.ts'
import * as SchemaModule from '../../../../modules/resources/ai/v1/job.schema.ts'
import * as AiGrpc from '../../../../modules/api-client/ai.ts'
import { GrpcDeadlineExceededError, GrpcError } from '../../../../modules/api-client/grpc-utils.ts'
import * as NebiusJobSchema from '../../../../schemas/nebius/ai/v1/job.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'
import { fakeSession, instanceIdLayer, stackLayer, testConfigLayer } from '../../../helpers/mocks.ts'

const { describe, expect, test } = BunTest

/** Minimal valid Job props (all required fields populated). */
const validJobProps = {
  image: 'ubuntu:22.04',
  platform: 'cpu-d3',
  preset: '4vcpu-16gb',
  subnetId: 'subnet-abc123',
  publicIp: false,
  preemptible: false,
  containerCommand: 'sleep',
  environmentVariables: [{ name: 'FOO', value: 'bar' }],
  ports: [{ containerPort: 8080, protocol: 'HTTP' }],
  volumes: [],
  disk: { type: 'NETWORK_SSD', sizeBytes: 107_374_182_400 }, // 100 GiB (≥ 64 GiB floor)
}

describe('Nebius.ai.v1.Job', () => {
  test('NebiusJob resource constructor is defined', () => {
    expect(Module.NebiusJob).toBeDefined()
    expect(typeof Module.NebiusJob).toBe('function')
  })

  test('NebiusJobProvider is defined', () => {
    expect(Module.NebiusJobProvider).toBeDefined()
  })

  describe('pricing (pricing_model)', () => {
    // The proto carries pricing as a oneof of three flat siblings *inside* a `pricingModel` message, so the
    // prop is a reshape — and a nested `pricing` key would be dropped silently by `fromJSON`. The
    // preemptible coupling is the API's own rule ("Must match the preemptible flag").
    const invalidPricing = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validateJobProps({ ...validJobProps, ...patch }).pipe(Effect.flip))
    const validPricing = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validateJobProps({ ...validJobProps, ...patch }))

    test('each arm is accepted on its matching preemptible flag', async () => {
      // The baseline is not preemptible, so `onDemand` is the arm that needs nothing else.
      await validPricing({ pricing: { onDemand: true } })
      await validPricing({ preemptible: true, pricing: { followsSpotPrice: true } })
      await validPricing({ preemptible: true, pricing: { spotPricingPolicy: { id: 'pricingpolicy-1' } } })
      // Omitting it stays valid either way: the platform's default (preemptible's own is the spot arm).
      await validPricing({})
      await validPricing({ preemptible: true })
    })

    test('“exactly one arm” and the preemptible coupling are plan-time errors', async () => {
      expect(String(await invalidPricing({ pricing: { onDemand: true, followsSpotPrice: true } }))).toContain(
        'exactly one',
      )
      expect(String(await invalidPricing({ pricing: {} }))).toContain('exactly one')
      expect(String(await invalidPricing({ preemptible: true, pricing: { onDemand: true } }))).toContain(
        'Must match the preemptible flag',
      )
      expect(String(await invalidPricing({ pricing: { followsSpotPrice: true } }))).toContain('requires `preemptible`')
      // A `false` switch is not transmittable — the wire arm is an empty message.
      expect(String(await invalidPricing({ pricing: { onDemand: false } }))).toContain('can only be set to true')
    })

    test('jobSpecInput nests the arms under `pricingModel`, and leaves no `pricing` key', () => {
      const onDemand = Module.jobSpecInput({ ...validJobProps, pricing: { onDemand: true } } as never)
      expect(onDemand.pricing).toBeUndefined()
      expect(onDemand.pricingModel).toEqual({ onDemand: {} })

      const policy = Module.jobSpecInput({
        ...validJobProps,
        preemptible: true,
        pricing: { spotPricingPolicy: { id: 'pricingpolicy-1' } },
      } as never)
      expect(policy.pricingModel).toEqual({ spotPricingPolicy: { id: 'pricingpolicy-1' } })

      // Omitted: nothing travels at all.
      const omitted = Module.jobSpecInput(validJobProps as never)
      expect(omitted.pricing).toBeUndefined()
      expect(omitted.pricingModel).toBeUndefined()
    })

    test('the nested message survives InstanceSpec-style decoding (fromJSON)', async () => {
      // The reshape's whole purpose: `{pricingModel: {onDemand: {}}}` has to decode into the proto's
      // `PricingModelSpec`, which flat `fromPartial`-style passing would not do.
      const decoded = await import('../../../../schemas/nebius/ai/v1/job.ts').then((schema) =>
        schema.JobSpec.fromJSON(Module.jobSpecInput({ ...validJobProps, pricing: { onDemand: true } } as never)),
      )
      expect(decoded.pricingModel?.onDemand).toBeDefined()
      expect(decoded.pricingModel?.followsSpotPrice).toBeUndefined()
    })
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      expect(await runDiff(svc, { ...validJobProps, name: 'new-job' }, { ...validJobProps, name: 'old-job' })).toEqual({ action: 'replace' })
    })

    test('spec change (image) requires replace — no update RPC', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      expect(await runDiff(svc, { ...validJobProps, image: 'ubuntu:24.04' }, { ...validJobProps, image: 'ubuntu:22.04' })).toEqual({
        action: 'replace',
      })
    })

    test('identical props is a noop', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      expect(await runDiff(svc, { ...validJobProps }, { ...validJobProps })).toBeUndefined()
    })

    test('labels-only change is a noop (documented drift)', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      expect(
        await runDiff(svc, { ...validJobProps, labels: { team: 'b' } }, { ...validJobProps, labels: { team: 'a' } }),
      ).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props (incl. mysterybox secret refs + base64 injected files)', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({
          ...validJobProps,
          environmentVariables: [
            { name: 'FOO', value: 'bar' },
            { name: 'SECRET', mysteryboxSecret: { secretId: 'sec-abc123', versionId: 'ver-abc123' } },
          ],
          injectedFiles: [{ containerPath: '/etc/app.conf', content: Buffer.from('{"a":1}').toString('base64') }],
        }),
      )
      expect(result.image).toBe('ubuntu:22.04')
      expect(result.environmentVariables[1].mysteryboxSecret?.secretId).toBe('sec-abc123')
    })

    test('rejects unknown disk type', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({
          ...validJobProps,
          disk: { type: 'NOT_A_TYPE', sizeBytes: 107_374_182_400 },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects missing disk (required by the API)', async () => {
      const { disk: _disk, ...withoutDisk } = validJobProps
      const result = await runEffect(
        SchemaModule.validateJobProps(withoutDisk).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects disks below the 64 GiB provisioning floor', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({
          ...validJobProps,
          disk: { type: 'NETWORK_SSD', sizeBytes: 16 * 1024 ** 3 },
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({ ...validJobProps, name: 'Bad Name!' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })

    test('rejects an environment variable with both value and mysteryboxSecret (XOR)', async () => {
      const result = await runEffect(
        SchemaModule.validateJobProps({
          ...validJobProps,
          environmentVariables: [
            { name: 'FOO', value: 'bar', mysteryboxSecret: { secretId: 'sec-abc123', versionId: 'ver-abc123' } },
          ],
        }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })

  describe('reconcile — create-failure recovery (R-20)', () => {
    // Drive the real reconcile through the create path (no persisted output), with a mocked AI
    // service whose `create` fails. R-20: the recovery lookup must only run for failures that can
    // hide a successful create — INVALID_ARGUMENT means the create never landed, so a getByName can
    // only add a wrong diagnosis and is skipped; DEADLINE_EXCEEDED can hide a landed create, so the
    // lookup still runs and adopts the recovered job.
    // oxlint-disable-next-line no-explicit-any — reconcile input mock (see provider.ts runReconcile)
    const reconcile = (svc: any, jobLayer: Layer.Layer<AiGrpc.AiGrpcService, never, never>) =>
      svc.reconcile({
        id: 'job_test',
        fqn: 'job_test',
        instanceId: 'inst',
        news: validJobProps,
        output: undefined,
        olds: undefined,
        session: fakeSession,
      }).pipe(
        Effect.provide(jobLayer),
        Effect.provide(testConfigLayer),
        Effect.provide(stackLayer),
        Effect.provide(instanceIdLayer),
      )

    test('INVALID_ARGUMENT makes exactly one create call and no getByName', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      let createCalls = 0
      let getByNameCalls = 0
      const jobLayer = Layer.succeed(AiGrpc.AiGrpcService, {
        job: {
          create: () => {
            createCalls += 1
            return Effect.fail(new GrpcError({ code: 3, message: 'invalid argument', details: '' }))
          },
          getByName: () => {
            getByNameCalls += 1
            return Effect.never
          },
        },
      } as unknown as AiGrpc.AiGrpcServiceShape)

      const failure = await runEffect(Effect.flip(reconcile(svc, jobLayer)))
      expect(failure).toMatchObject({ _tag: 'GrpcError', code: 3, message: 'invalid argument' })
      expect(createCalls).toBe(1)
      expect(getByNameCalls).toBe(0)
    })

    test('DEADLINE_EXCEEDED still recovers via getByName', async () => {
      const svc = await resolveProvider(Module.NebiusJob.Provider, Module.NebiusJobProvider)
      let createCalls = 0
      const getByNameCalls: Array<{ parentId: string; name: string }> = []
      const jobLayer = Layer.succeed(AiGrpc.AiGrpcService, {
        job: {
          create: () => {
            createCalls += 1
            return Effect.fail(new GrpcDeadlineExceededError({ message: 'deadline exceeded' }))
          },
          getByName: (req: { parentId: string; name: string }) => {
            getByNameCalls.push(req)
            return Effect.succeed(
              NebiusJobSchema.Job.fromJSON({
                metadata: { id: 'job-abc123', parentId: req.parentId, name: req.name },
                spec: {},
                status: {},
              }),
            )
          },
        },
      } as unknown as AiGrpc.AiGrpcServiceShape)

      const result = await runEffect(reconcile(svc, jobLayer))
      expect(createCalls).toBe(1)
      expect(getByNameCalls).toHaveLength(1)
      expect(getByNameCalls[0]!.parentId).toBe('project-test-1')
      expect(result.id).toBe('job-abc123')
    })
  })
})
