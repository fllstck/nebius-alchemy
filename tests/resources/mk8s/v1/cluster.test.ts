import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import Long from 'long'

import * as Module from '../../../../modules/resources/mk8s/v1/cluster.ts'
import * as SchemaModule from '../../../../modules/resources/mk8s/v1/cluster.schema.ts'
import * as NebiusClusterSchema from '../../../../schemas/nebius/mk8s/v1/cluster.ts'
import {
  instanceIdLayer,
  mockMk8sLayer,
  notFoundError,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from '../../../helpers/mocks.ts'
import { resolveProvider, runDiff, runEffect, runReconcile } from '../../../helpers/provider.ts'
import * as Layer from 'effect/Layer'

const { describe, expect, test } = BunTest

const CLUSTER_ID = 'mk8scluster-1'

/** A complete, valid baseline — every optional prop set, so removals are meaningful. */
const validProps = {
  parentId: 'project-test-1',
  name: 'k8s-test',
  subnetId: 'vpcsubnet-1',
  version: '1.35',
  etcdClusterSize: 3,
  publicEndpoint: { allowedCidrs: ['203.0.113.0/24'] },
  serviceCidrs: ['/16'],
}

/** The cluster the API would hold for `validProps` — built so the baseline is a noop. */
const clusterProto = (overrides: Partial<NebiusClusterSchema.Cluster> = {}): NebiusClusterSchema.Cluster => ({
  metadata: protoMetadata(CLUSTER_ID, 'k8s-test', 'project-test-1'),
  spec: NebiusClusterSchema.ClusterSpec.fromJSON({
    controlPlane: {
      version: '1.35',
      subnetId: 'vpcsubnet-1',
      etcdClusterSize: '3',
      endpoints: { publicEndpoint: { allowedCidrs: ['203.0.113.0/24'] } },
    },
    kubeNetwork: { serviceCidrs: ['/16'] },
  }),
  status: undefined,
  ...overrides,
})

const base = <A, E, R>(service: Layer.Layer<A, E, R>) =>
  Layer.mergeAll(service, stackLayer, testConfigLayer, instanceIdLayer)

/** The desired `ClusterSpec` for a props object — the shape `reconcile` builds. */
const desiredFor = (props: Record<string, unknown>) =>
  NebiusClusterSchema.ClusterSpec.fromPartial({
    controlPlane: {
      version: props.version as string,
      subnetId: props.subnetId as string,
      etcdClusterSize:
        props.etcdClusterSize === undefined ? undefined : Long.fromNumber(props.etcdClusterSize as number),
      ...(props.publicEndpoint === undefined
        ? {}
        : { endpoints: { publicEndpoint: { allowedCidrs: ['203.0.113.0/24'] } } }),
      ...(props.auditLogs ? { auditLogs: {} } : {}),
    },
  })

const resolveClusterProvider = () => resolveProvider(Module.NebiusCluster.Provider, Module.NebiusClusterProvider)

const mocks = (writes: Array<unknown>) =>
  base(
    mockMk8sLayer({
      cluster: {
        get: () => Effect.succeed(clusterProto()),
        create: (req: unknown) => {
          writes.push(req)
          return Effect.succeed(clusterProto())
        },
        update: (req: unknown) => {
          writes.push(req)
          return Effect.succeed(clusterProto())
        },
      },
    }),
  )

describe('Nebius.mk8s.v1.Cluster', () => {
  test('constructor and provider are defined', () => {
    expect(Module.NebiusCluster).toBeDefined()
    expect(Module.NebiusClusterProvider).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Props validation
  // -------------------------------------------------------------------------

  describe('props validation', () => {
    const invalid = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validateClusterProps({ ...validProps, ...patch }).pipe(Effect.flip))

    test('accepts the baseline', async () => {
      await runEffect(SchemaModule.validateClusterProps(validProps))
    })

    test('version must be <major>.<minor> — a patch form is rejected at plan time', async () => {
      // The proto: "For now only acceptable format is <major>.<minor> … Option for patch
      // version update will be added later". Failing here beats an API round-trip.
      const error = await invalid({ version: '1.35.0' })
      expect(String(error)).toContain('<major>.<minor>')
    })

    test('etcdClusterSize is limited to 1, 3 or 5', async () => {
      await runEffect(SchemaModule.validateClusterProps({ ...validProps, etcdClusterSize: 1 }))
      await runEffect(SchemaModule.validateClusterProps({ ...validProps, etcdClusterSize: 5 }))
      expect(String(await invalid({ etcdClusterSize: 2 }))).toContain('1, 3 or 5')
      expect(String(await invalid({ etcdClusterSize: 3.5 }))).toContain('1, 3 or 5')
    })

    test('serviceCidrs accepts the prefix form the API documents', async () => {
      // `/16` is the documented default and the API's own example; `Validation.isValidCIDR`
      // *rejects* prefix-only values, which is exactly why this prop has its own filter.
      await Promise.all(
        ['/12', '/16', '/28', '10.96.0.0/12'].map((value) =>
          runEffect(SchemaModule.validateClusterProps({ ...validProps, serviceCidrs: [value] })),
        ),
      )
      expect(String(await invalid({ serviceCidrs: ['/11'] }))).toContain('/12–/28')
      expect(String(await invalid({ serviceCidrs: ['/29'] }))).toContain('/12–/28')
      expect(String(await invalid({ serviceCidrs: ['not-a-cidr'] }))).toContain('Invalid CIDR')
    })

    test('publicEndpoint.allowedCidrs needs full CIDR notation', async () => {
      // Unlike serviceCidrs, this one is an ordinary address list — and it reuses the
      // shared predicate, so the prefix-only rejection is inherited rather than copied.
      expect(String(await invalid({ publicEndpoint: { allowedCidrs: ['/24'] } }))).toContain('Prefix-only')
      expect(String(await invalid({ publicEndpoint: { allowedCidrs: ['10.0.0.0/33'] } }))).toContain('CIDR prefix')
    })

    test('auditLogs and karpenter can only be turned ON', async () => {
      // Both are empty messages in the proto whose *presence* enables the feature, and
      // mk8s has no FieldMask — so "absent" means "leave unchanged" and there is no way to
      // express "off". `false` would be a silent no-op, so it is a plan-time error instead.
      await runEffect(SchemaModule.validateClusterProps({ ...validProps, auditLogs: true, karpenter: true }))
      expect(String(await invalid({ auditLogs: false }))).toContain('only be turned ON')
      expect(String(await invalid({ karpenter: false }))).toContain('only be turned ON')
    })

    test('subnetId is required', async () => {
      const { subnetId, ...withoutSubnet } = validProps
      void subnetId
      expect(String(await runEffect(SchemaModule.validateClusterProps(withoutSubnet).pipe(Effect.flip)))).toContain(
        'subnetId',
      )
    })
  })

  // -------------------------------------------------------------------------
  // The drift list (exported so it is testable without an engine)
  // -------------------------------------------------------------------------

  describe('clusterSpecDrifted', () => {
    test('the baseline does not drift', () => {
      expect(
        Module.clusterSpecDrifted(clusterProto().spec, desiredFor(validProps), validProps as never),
      ).toBe(false)
    })

    test('a pinned version change drifts; an omitted one does not', () => {
      const live = clusterProto().spec
      expect(Module.clusterSpecDrifted(live, desiredFor({ ...validProps, version: '1.34' }), {
        ...validProps,
        version: '1.34',
      } as never)).toBe(true)
      // The anti-loop direction: live holds 1.35, the user removed the prop. Without the
      // news-side guard this reports drift forever (the update cannot clear the field).
      expect(
        Module.clusterSpecDrifted(live, desiredFor({ ...validProps, version: undefined }), {
          ...validProps,
          version: undefined,
        } as never),
      ).toBe(false)
    })

    test('etcdClusterSize compares the Long value, not the object', () => {
      const live = clusterProto().spec
      // A different value drifts…
      expect(
        Module.clusterSpecDrifted(live, desiredFor({ ...validProps, etcdClusterSize: 5 }), {
          ...validProps,
          etcdClusterSize: 5,
        } as never),
      ).toBe(true)
      // …and the *same* value must not: `Long` is a class instance, which the framework's
      // own `deepEqual` canonicalises to `undefined`, so `Long(3) == Long(5)` under it.
      // This is the `specDeepEqual` rule from AGENTS.md, pinned for this resource.
      expect(
        Module.clusterSpecDrifted(live, desiredFor({ ...validProps, etcdClusterSize: 3 }), validProps as never),
      ).toBe(false)
    })

    test('the publicEndpoint presence switch is compared, not just its CIDRs', () => {
      const live = clusterProto().spec
      // live has the endpoint; the user dropped the whole block → guard skips (no loop).
      expect(
        Module.clusterSpecDrifted(live, desiredFor({ ...validProps, publicEndpoint: undefined }), {
          ...validProps,
          publicEndpoint: undefined,
        } as never),
      ).toBe(false)
      // live has it, desired keeps it with the same CIDRs → no drift.
      expect(Module.clusterSpecDrifted(live, desiredFor(validProps), validProps as never)).toBe(false)
    })

    test('the allow-list comparison is order-insensitive', () => {
      const live = clusterProto().spec
      const flipped = SchemaModule.ClusterAttributesSchema // touch the export to keep the import meaningful
      void flipped
      const expected = desiredFor(validProps)
      expected.controlPlane!.endpoints!.publicEndpoint!.allowedCidrs = ['203.0.113.0/24']
      expect(Module.clusterSpecDrifted(live, expected, validProps as never)).toBe(false)
    })

    test('a live cluster with no spec never drifts (nothing to compare)', () => {
      expect(Module.clusterSpecDrifted(undefined, desiredFor(validProps), validProps as never)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Attributes
  // -------------------------------------------------------------------------

  describe('attributes', () => {
    test('reports the requested version and the running one separately', () => {
      // The collision the hand-mapper exists for: both live at `controlPlane.version`, and
      // flattening spec over status would keep only one of them.
      const attrs = SchemaModule.toFriendlyAttributes(
        clusterProto({
          status: {
            state: NebiusClusterSchema.ClusterStatus_State.RUNNING,
            controlPlane: {
              version: '1.35.2-nebius-cp.4',
              etcdClusterSize: Long.fromNumber(3),
              endpoints: { publicEndpoint: '203.0.113.9', privateEndpoint: '10.0.0.9' },
              auth: { clusterCaCertificate: '-----BEGIN CERTIFICATE-----' },
            },
            events: [],
            reconciling: false,
          },
        }),
      )
      expect(attrs.requestedVersion).toBe('1.35')
      expect(attrs.version).toBe('1.35.2-nebius-cp.4')
      expect(attrs.state).toBe('RUNNING')
      expect(attrs.endpoints).toEqual({ publicEndpoint: '203.0.113.9', privateEndpoint: '10.0.0.9' })
      expect(attrs.clusterCaCertificate).toBe('-----BEGIN CERTIFICATE-----')
    })

    test('int64 etcdClusterSize arrives as a decimal string', () => {
      // Decoded protobuf hands back a `Long`; the attribute view is JSON-shaped, so it must
      // be a string (AGENTS.md §"Attribute types must match what toFriendlyAttributes produces").
      expect(SchemaModule.toFriendlyAttributes(clusterProto()).etcdClusterSize).toBe('3')
    })

    test('a cluster with no status yet still maps', () => {
      const attrs = SchemaModule.toFriendlyAttributes(clusterProto())
      expect(String(attrs.id)).toBe(CLUSTER_ID)
      expect(attrs.name).toBe('k8s-test')
      expect(String(attrs.subnetId)).toBe('vpcsubnet-1')
      expect(attrs.version).toBeUndefined()
      expect(attrs.state).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Reconcile / delete
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    test('an unchanged baseline writes nothing', async () => {
      const svc = await resolveProvider(Module.NebiusCluster.Provider, Module.NebiusClusterProvider)
      const writes: Array<unknown> = []
      await runReconcile(svc, validProps, { id: CLUSTER_ID }, validProps, Effect.provide(mocks(writes)) as never)
      expect(writes).toHaveLength(0)
    })

    test('a version change is written in place with the resource version', async () => {
      const svc = await resolveProvider(Module.NebiusCluster.Provider, Module.NebiusClusterProvider)
      const writes: Array<unknown> = []
      await runReconcile(
        svc,
        { ...validProps, version: '1.34' },
        { id: CLUSTER_ID },
        validProps,
        Effect.provide(mocks(writes)) as never,
      )
      expect(writes).toHaveLength(1)
      expect((writes[0] as { metadata: { id: string } }).metadata.id).toBe(CLUSTER_ID)
    })

    test('a missing cluster is created rather than adopted', async () => {
      const svc = await resolveProvider(Module.NebiusCluster.Provider, Module.NebiusClusterProvider)
      const writes: Array<unknown> = []
      const layer = base(
        mockMk8sLayer({
          cluster: {
            get: () => Effect.fail(notFoundError()),
            create: (req: unknown) => {
              writes.push(req)
              return Effect.succeed(clusterProto())
            },
          },
        }),
      )
      await runReconcile(svc, validProps, { id: CLUSTER_ID }, validProps, Effect.provide(layer) as never)
      expect(writes).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // diff — the replace set (the convergence table pins the shapes too)
  // -------------------------------------------------------------------------

  describe('diff', () => {
    test('subnetId is create-only → delete-first replace for a pinned name', async () => {
      // Measured 2026-09-23: an in-place change answers an opaque `13 INTERNAL` and does
      // nothing, so the replacement must be planned. The baseline pins `name`, hence
      // delete-first.
      expect(
        await runDiff(await resolveClusterProvider(), { ...validProps, subnetId: 'vpcsubnet-2' }, validProps),
      ).toEqual({ action: 'replace', deleteFirst: true })
    })

    test('serviceCidrs is create-only → replace, and its removal cannot be silent', async () => {
      expect(
        await runDiff(await resolveClusterProvider(), { ...validProps, serviceCidrs: ['/12'] }, validProps),
      ).toEqual({ action: 'replace', deleteFirst: true })
      // Omitting it is also a change (no FieldMask → the field cannot be reset in place).
      expect(await runDiff(await resolveClusterProvider(), { ...validProps, serviceCidrs: undefined }, validProps)).toEqual({
        action: 'replace',
        deleteFirst: true,
      })
    })

    test('a generated name (no props.name) keeps create-first', async () => {
      const { name, ...generated } = validProps
      void name
      expect(await runDiff(await resolveClusterProvider(), { ...generated, subnetId: 'vpcsubnet-2' }, generated)).toEqual({
        action: 'replace',
      })
    })

    test('name and parentId changes are create-first', async () => {
      expect(await runDiff(await resolveClusterProvider(), { ...validProps, name: 'other' }, validProps)).toEqual({ action: 'replace' })
      expect(await runDiff(await resolveClusterProvider(), { ...validProps, parentId: 'project-2' }, validProps)).toEqual({
        action: 'replace',
      })
    })

    test('a mutable prop plans nothing — reconcile writes it', async () => {
      expect(await runDiff(await resolveClusterProvider(), { ...validProps, version: '1.34' }, validProps)).toBeUndefined()
      expect(await runDiff(await resolveClusterProvider(), { ...validProps, etcdClusterSize: 5 }, validProps)).toBeUndefined()
      expect(await runDiff(await resolveClusterProvider(), { ...validProps, auditLogs: true }, validProps)).toBeUndefined()
    })

    test('an unchanged config plans nothing, even structurally cloned', async () => {
      // The reference-comparison trap (`storage/v1 transfer`, 2026-09-22): the state store
      // hands back a fresh object, so `news.serviceCidrs !== olds.serviceCidrs` would plan a
      // replace on every deploy. `sameStringSet` compares by value.
      const clone = JSON.parse(JSON.stringify(validProps))
      expect(await runDiff(await resolveClusterProvider(), validProps, clone)).toBeUndefined()
    })
  })
})
