import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import Long from 'long'

import * as Module from '../../../../modules/resources/mk8s/v1/node-group.ts'
import * as SchemaModule from '../../../../modules/resources/mk8s/v1/node-group.schema.ts'
import * as CapacityIds from '../../../../modules/resources/capacity/v1/ids.ts'
import * as NebiusNodeGroupSchema from '../../../../schemas/nebius/mk8s/v1/node_group.ts'
import {
  instanceIdLayer,
  mockMk8sLayer,
  notFoundError,
  protoMetadata,
  stackLayer,
  testConfigLayer,
} from '../../../helpers/mocks.ts'
import { resolveProvider, runDelete, runDiff, runEffect, runReconcile } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

const NODE_GROUP_ID = 'mk8snodegroup-1'
const CLUSTER_ID = 'mk8scluster-1'

/** A complete, valid baseline — every optional prop set, so removals are meaningful. */
const validProps = {
  parentId: CLUSTER_ID,
  name: 'nodes-1',
  version: '1.35',
  fixedNodeCount: 2,
  template: {
    os: 'ubuntu24.04',
    resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
    bootDisk: { sizeGibibytes: 64, blockSizeBytes: 4096, type: 'NETWORK_SSD' as const },
    networkInterfaces: [{ subnetId: 'vpcsubnet-1' }],
    serviceAccountId: 'serviceaccount-abc123',
    cloudInitUserData: '#cloud-config\n',
  },
}

/**
 * The node group the API would hold for {@link validProps}.
 *
 * Deliberately built with `fromJSON` (the shape the api-client's decoded protobuf
 * produces, so int64s are real `Long`s), and deliberately carrying the platform's **own**
 * additions: `maxPods: 110` (the proto documents that default), the empty repeated
 * fields, and a `blockSizeBytes` echo. None of those are props, so none of them may ever
 * cause drift — that is the class that made `vpc/v1 Network`'s pools and
 * `transfer.limiters` write on every reconcile.
 */
const nodeGroupProto = (overrides: Partial<NebiusNodeGroupSchema.NodeGroup> = {}): NebiusNodeGroupSchema.NodeGroup => ({
  metadata: protoMetadata(NODE_GROUP_ID, 'nodes-1', CLUSTER_ID),
  spec: NebiusNodeGroupSchema.NodeGroupSpec.fromJSON({
    version: '1.35',
    fixedNodeCount: '2',
    template: {
      os: 'ubuntu24.04',
      resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
      bootDisk: { sizeGibibytes: '64', blockSizeBytes: '4096', type: 'NETWORK_SSD' },
      networkInterfaces: [{ subnetId: 'vpcsubnet-1' }],
      serviceAccountId: 'serviceaccount-abc123',
      cloudInitUserData: '#cloud-config\n',
      maxPods: '110',
      taints: [],
      filesystems: [],
    },
  }),
  status: undefined,
  ...overrides,
})

const base = <A, E, R>(service: Layer.Layer<A, E, R>) =>
  Layer.mergeAll(service, stackLayer, testConfigLayer, instanceIdLayer)

const mocks = (writes: Array<unknown>) =>
  base(
    mockMk8sLayer({
      nodeGroup: {
        get: () => Effect.succeed(nodeGroupProto()),
        create: (req: unknown) => {
          writes.push(req)
          return Effect.succeed(nodeGroupProto())
        },
        update: (req: unknown) => {
          writes.push(req)
          return Effect.succeed(nodeGroupProto())
        },
        delete: () => Effect.succeed(undefined),
      },
    }),
  )

const resolveNodeGroupProvider = () =>
  resolveProvider(Module.NebiusNodeGroup.Provider, Module.NebiusNodeGroupProvider)

/** The wire spec `reconcile` builds for a props object — the shape the drift check sees. */
const desiredFor = (props: Record<string, unknown>) => Module.desiredSpec(props as never)

describe('Nebius.mk8s.v1.NodeGroup', () => {
  test('constructor and provider are defined', () => {
    expect(Module.NebiusNodeGroup).toBeDefined()
    expect(Module.NebiusNodeGroupProvider).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Props validation
  // -------------------------------------------------------------------------

  describe('props validation', () => {
    const invalid = (patch: Record<string, unknown>) =>
      runEffect(SchemaModule.validateNodeGroupProps({ ...validProps, ...patch }).pipe(Effect.flip))
    const invalidTemplate = (patch: Record<string, unknown>) =>
      runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: { ...validProps.template, ...patch },
        }).pipe(Effect.flip),
      )
    const invalidBootDisk = (patch: Record<string, unknown>) =>
      invalidTemplate({ bootDisk: { ...validProps.template.bootDisk, ...patch } })

    test('accepts the baseline', async () => {
      await runEffect(SchemaModule.validateNodeGroupProps(validProps))
    })

    test('the parent is the cluster, and it is required', async () => {
      // A node group is parented by a Cluster, not the project — so unlike every
      // project-parented resource there is no `NEBIUS_PROJECT_ID` fallback to fall back to.
      const { parentId: _dropped, ...withoutParent } = validProps
      expect(String(await runEffect(SchemaModule.validateNodeGroupProps(withoutParent).pipe(Effect.flip)))).toContain(
        'parentId',
      )
    })

    test('version must be <major>.<minor> — a patch form is rejected at plan time', async () => {
      expect(String(await invalid({ version: '1.35.0' }))).toContain('<major>.<minor>')
      // The node group's message names its own authority: the cluster's resolved version.
      expect(String(await invalid({ version: '1.35.0' }))).toContain("inherit the cluster's resolved version")
    })

    test('fixedNodeCount 0 is rejected: it is indistinguishable from an omitted field', async () => {
      expect(String(await invalid({ fixedNodeCount: 0 }))).toContain('positive integer')
      expect(String(await invalid({ fixedNodeCount: 1.5 }))).toContain('positive integer')
    })

    test('template.os must be non-empty (an empty scalar is not sent at all)', async () => {
      expect(String(await invalidTemplate({ os: '' }))).toContain('must not be empty')
    })

    test('resources.platform is required and non-empty; preset may be omitted but not blank', async () => {
      expect(String(await invalidTemplate({ resources: { platform: '' } }))).toContain('must not be empty')
      expect(String(await invalidTemplate({ resources: { preset: '2vcpu-8gb' } }))).toContain('platform')
      expect(String(await invalidTemplate({ resources: { platform: 'cpu-d3', preset: '' } }))).toContain(
        'must not be empty',
      )
    })

    test('the boot disk size floor is the platform rule: ≥ 64 GiB', async () => {
      // Measured on compute boot disks (a smaller disk never reaches cloud-init), and the
      // mk8s probe used exactly 64 GiB on cpu-d3 — so the filter is inherited rather than
      // left to a silent stall mid-provisioning.
      expect(String(await invalidBootDisk({ sizeGibibytes: 32 }))).toContain('64')
    })

    test('blockSizeBytes must be a power of two in range when given', async () => {
      expect(String(await invalidBootDisk({ blockSizeBytes: 5000 }))).toContain('power of two')
      // Omitted is legal: the platform's default applies and is never compared.
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: { ...validProps.template, bootDisk: { sizeGibibytes: 64, type: 'NETWORK_SSD' } },
        }),
      )
    })

    test('bootDisk.type is required and UNSPECIFIED is not offered', async () => {
      expect(String(await invalidBootDisk({ type: 'UNSPECIFIED' }))).toContain('type')
      expect(String(await invalidBootDisk({ type: 'NOT_A_DISK' }))).toContain('type')
    })

    test('cloudInitUserData is required and non-empty', async () => {
      expect(String(await invalidTemplate({ cloudInitUserData: '' }))).toContain('must not be empty')
    })

    test('the SSH key inside cloudInitUserData is NOT enforced (the API accepts a key-less payload)', async () => {
      // Measured 2026-09-23: the write probe created a node group with `'#cloud-config\n'`
      // and no key. The solutions library validates a key; the API does not — so rejecting
      // it here would reject a configuration the platform demonstrably serves. The props
      // document the consequence (no SSH path into a node) instead.
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: { ...validProps.template, cloudInitUserData: '#cloud-config\npackages:\n  - nginx\n' },
        }),
      )
    })

    test('publicIpAddress is a presence-only switch, so false is a plan-time error', async () => {
      const error = await invalidTemplate({
        networkInterfaces: [{ subnetId: 'vpcsubnet-1', publicIpAddress: false }],
      })
      expect(String(error)).toContain('can only be turned ON')
      // `true` (and omission) are both fine.
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: {
            ...validProps.template,
            networkInterfaces: [{ publicIpAddress: true }, { subnetId: 'vpcsubnet-1' }],
          },
        }),
      )
    })

    // ── arm 2: sizing, strategy, auto-repair ────────────────────────────────

    test('exactly one of fixedNodeCount / autoscaling must be set', async () => {
      // Omitted sizing is rejected: the API has no default node count to fall back on.
      expect(String(await invalid({ fixedNodeCount: undefined }))).toContain('set either fixedNodeCount or autoscaling')
      // Both together is the API's documented mutual exclusion.
      expect(
        String(await invalid({ autoscaling: { minNodeCount: 1, maxNodeCount: 2 } })),
      ).toContain('mutually exclusive')
      // The autoscaled shape alone is valid.
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          fixedNodeCount: undefined,
          autoscaling: { minNodeCount: 1, maxNodeCount: 3 },
        }),
      )
    })

    test('autoscaling bounds are positive and ordered', async () => {
      const auto = (patch: Record<string, unknown>) =>
        invalid({ fixedNodeCount: undefined, autoscaling: { minNodeCount: 1, maxNodeCount: 3, ...patch } })
      // `0` in either bound cannot be transmitted as a change (proto3), so it is a plan-time error
      // rather than a prop whose value silently never leaves.
      expect(String(await auto({ minNodeCount: 0 }))).toContain('positive integer')
      expect(String(await auto({ maxNodeCount: 0 }))).toContain('positive integer')
      expect(String(await auto({ minNodeCount: 5, maxNodeCount: 3 }))).toContain('maxNodeCount must be >= minNodeCount')
    })

    test('PercentOrCount takes exactly one of count or percent', async () => {
      const strategy = (patch: Record<string, unknown>) => invalid({ strategy: patch })
      // Both at once: a `Schema.Union` of two structs would have silently dropped `percent`
      // (measured 2026-09-23), which is why the props use a two-way filter.
      expect(String(await strategy({ maxUnavailable: { count: 1, percent: 20 } }))).toContain('exactly one')
      // Neither.
      expect(String(await strategy({ maxUnavailable: {} }))).toContain('exactly one')
      // Out of range / non-integer.
      expect(String(await strategy({ maxSurge: { percent: 0 } }))).toContain('1-100')
      expect(String(await strategy({ maxSurge: { percent: 101 } }))).toContain('1-100')
      expect(String(await strategy({ maxSurge: { percent: 2.5 } }))).toContain('1-100')
      expect(String(await strategy({ maxSurge: { count: 0 } }))).toContain('positive integer')
      // Each arm alone is valid.
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          strategy: { maxUnavailable: { count: 1 }, maxSurge: { percent: 25 }, drainTimeoutSeconds: 600 },
        }),
      )
    })

    test('an empty strategy block is rejected (it is not a presence switch)', async () => {
      // With no FieldMask an empty message means "leave unchanged", and `pinnedSpecDeepEqual` reads
      // an empty object as a *presence* switch — which `strategy` is not. Omit the block instead.
      expect(String(await invalid({ strategy: {} }))).toContain('at least one of maxUnavailable')
    })

    test('duration props are in seconds and must be positive', async () => {
      // `0` encodes as an absent field, so "no timeout" (the proto's meaning for 0) cannot be set as
      // a change — a plan-time error beats a value that never leaves the props.
      expect(String(await invalid({ strategy: { drainTimeoutSeconds: 0 } }))).toContain('positive whole number of seconds')
      expect(
        String(
          await invalid({
            autoRepair: { conditions: [{ type: 'Ready', status: 'FALSE', timeoutSeconds: 0 }] },
          }),
        ),
      ).toContain('positive whole number of seconds')
    })

    test('autoRepair conditions need a type, a real status and at least one entry', async () => {
      expect(String(await invalid({ autoRepair: { conditions: [] } }))).toContain('at least one condition')
      expect(
        String(await invalid({ autoRepair: { conditions: [{ type: '', status: 'FALSE' }] } })),
      ).toContain('must not be empty')
      // `CONDITION_STATUS_UNSPECIFIED` is not offered — an unset status is "the platform decides".
      expect(
        String(await invalid({ autoRepair: { conditions: [{ type: 'Ready', status: 'UNSPECIFIED' }] } })),
      ).toContain('status')
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          autoRepair: { conditions: [{ type: 'Ready', status: 'UNKNOWN', timeoutSeconds: 300 }] },
        }),
      )
    })

    // ── arm 4: labels, taints, filesystems, local disks, preemptible, maxPods, reservations ──

    test('the two label maps are separate and a label key cannot be empty', async () => {
      // `template.metadata.labels` = Kubernetes node labels; `template.instanceMetadata.labels` =
      // the compute instance's metadata. Two maps in one template.
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: {
            ...validProps.template,
            metadata: { labels: { 'node-role': 'worker' } },
            instanceMetadata: { labels: { team: 'platform' } },
          },
        }),
      )
      expect(String(await invalidTemplate({ metadata: { labels: { '': 'worker' } } }))).toContain('metadata')
    })

    test('taints need a key and a real effect; the value may be empty', async () => {
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: {
            ...validProps.template,
            // An empty taint *value* is legal and common (`kubectl taint key:NoSchedule`).
            taints: [{ key: 'dedicated', value: '', effect: 'NO_SCHEDULE' }],
          },
        }),
      )
      expect(
        String(await invalidTemplate({ taints: [{ key: '', value: 'x', effect: 'NO_SCHEDULE' }] })),
      ).toContain('must not be empty')
      expect(
        String(await invalidTemplate({ taints: [{ key: 'k', value: 'v', effect: 'EFFECT_UNSPECIFIED' }] })),
      ).toContain('effect')
    })

    test('a filesystem attachment needs a mode, a mount tag and an existing filesystem', async () => {
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: {
            ...validProps.template,
            filesystems: [
              { attachMode: 'READ_WRITE', mountTag: 'data', existingFilesystem: { id: 'computefilesystem-1' } },
            ],
          },
        }),
      )
      // The mount tag cap is the proto's: 1-37 characters.
      expect(
        String(
          await invalidTemplate({
            filesystems: [
              {
                attachMode: 'READ_WRITE',
                mountTag: 'x'.repeat(38),
                existingFilesystem: { id: 'computefilesystem-1' },
              },
            ],
          }),
        ),
      ).toContain('37')
    })

    test('preemptible is a presence-only switch', async () => {
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: { ...validProps.template, preemptible: true },
        }),
      )
      expect(String(await invalidTemplate({ preemptible: false }))).toContain('can only be turned ON')
    })

    test('local disks: true-only flags, one config arm, and no empty block', async () => {
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: {
            ...validProps.template,
            localDisks: { passthroughGroup: { requested: true }, config: { kubeletEphemeral: true } },
          },
        }),
      )
      expect(String(await invalidTemplate({ localDisks: {} }))).toContain('must set passthroughGroup or config')
      expect(
        String(await invalidTemplate({ localDisks: { passthroughGroup: { requested: false } } })),
      ).toContain('can only be set to true')
      expect(
        String(await invalidTemplate({ localDisks: { config: { none: true, kubeletEphemeral: true } } })),
      ).toContain('takes one arm')
      expect(String(await invalidTemplate({ localDisks: { config: { none: false } } }))).toContain(
        'can only be set to true',
      )
    })

    test('maxPods is optional but cannot be 0', async () => {
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: { ...validProps.template, maxPods: 110 },
        }),
      )
      expect(String(await invalidTemplate({ maxPods: 0 }))).toContain('positive integer')
    })

    test('reservationPolicy: AUTO is not offered, FORBID takes no ids, ids need a policy', async () => {
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: {
            ...validProps.template,
            reservationPolicy: {
              policy: 'STRICT',
              reservationIds: [CapacityIds.CapacityBlockGroupId.make('capacityblockgroup-1')],
            },
          },
        }),
      )
      // AUTO is the proto's zero value: it cannot be sent as a change, and omitting `policy` is what
      // "prefer my reservations, then PAYG" means — so it is not a value a caller can pick.
      expect(String(await invalidTemplate({ reservationPolicy: { policy: 'AUTO' } }))).toContain('policy')
      // The API rejects ids with FORBID, so the filter does too.
      expect(
        String(
          await invalidTemplate({
            reservationPolicy: { policy: 'FORBID', reservationIds: ['capacityblockgroup-1'] },
          }),
        ),
      ).toContain('rejects reservationIds together with policy FORBID')
      expect(String(await invalidTemplate({ reservationPolicy: {} }))).toContain('must set policy')
      // Ids alone are the AUTO-with-preference case.
      await runEffect(
        SchemaModule.validateNodeGroupProps({
          ...validProps,
          template: {
            ...validProps.template,
            reservationPolicy: { reservationIds: [CapacityIds.CapacityBlockGroupId.make('capacityblockgroup-1')] },
          },
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // The drift list (exported so it is testable without an engine)
  // -------------------------------------------------------------------------

  describe('nodeGroupSpecDrifted', () => {
    test('the baseline does not drift, even though the live spec carries more than the props', () => {
      // The live fixture holds the API's own echo (`maxPods: 0` from a live run, the empty
      // `taints`/`filesystems`, a `blockSizeBytes` default) — all unpinned → invisible.
      expect(Module.nodeGroupSpecDrifted(nodeGroupProto().spec, desiredFor(validProps))).toBe(false)
    })

    test('the maxPods default cannot loop even if a platform wrote it into the spec', () => {
      // The hazard this covers: a platform that materializes a default the props never carried would
      // make a whole-spec comparison write on every reconcile, forever. `nodeGroupProto` holds 110
      // on purpose (the *stronger* case — a live run measured the real echo as `0`).
      const live = nodeGroupProto().spec!
      expect(live.template!.maxPods.toString()).toBe('110')
      expect(Module.nodeGroupSpecDrifted(live, desiredFor(validProps))).toBe(false)
    })

    test('an unpinned blockSizeBytes echo cannot loop; a pinned one is compared', () => {
      // Live holds 4096. Omitted from props → invisible.
      const without = {
        ...validProps,
        template: { ...validProps.template, bootDisk: { sizeGibibytes: 64, type: 'NETWORK_SSD' as const } },
      }
      expect(Module.nodeGroupSpecDrifted(nodeGroupProto().spec, desiredFor(without))).toBe(false)
      // Pinned to the same value → still no drift…
      expect(Module.nodeGroupSpecDrifted(nodeGroupProto().spec, desiredFor(validProps))).toBe(false)
      // …and pinned to a different value → drift.
      const other = {
        ...validProps,
        template: { ...validProps.template, bootDisk: { ...validProps.template.bootDisk, blockSizeBytes: 8192 } },
      }
      expect(Module.nodeGroupSpecDrifted(nodeGroupProto().spec, desiredFor(other))).toBe(true)
    })

    test('a pinned version change drifts; an omitted one does not', () => {
      const live = nodeGroupProto().spec
      expect(Module.nodeGroupSpecDrifted(live, desiredFor({ ...validProps, version: '1.34' }))).toBe(true)
      // The anti-loop direction: live holds 1.35, the user removed the prop. With no
      // FieldMask the update cannot clear the field, so comparing it would write forever.
      expect(Module.nodeGroupSpecDrifted(live, desiredFor({ ...validProps, version: undefined }))).toBe(false)
    })

    test('fixedNodeCount compares the int64 value, not the object', () => {
      const live = nodeGroupProto().spec
      expect(Module.nodeGroupSpecDrifted(live, desiredFor({ ...validProps, fixedNodeCount: 5 }))).toBe(true)
      // `Long` is a class instance, which the framework's own `deepEqual` canonicalises to
      // `undefined` — the `specDeepEqual` rule pinned at the leaf.
      expect(Module.nodeGroupSpecDrifted(live, desiredFor({ ...validProps, fixedNodeCount: 2 }))).toBe(false)
      expect(Module.nodeGroupSpecDrifted(live, desiredFor({ ...validProps, fixedNodeCount: undefined }))).toBe(false)
    })

    test('a template change drifts: os, resources and the pinned network interface', () => {
      const live = nodeGroupProto().spec
      expect(
        Module.nodeGroupSpecDrifted(live, desiredFor({ ...validProps, template: { ...validProps.template, os: 'ubuntu22.04' } })),
      ).toBe(true)
      expect(
        Module.nodeGroupSpecDrifted(
          live,
          desiredFor({
            ...validProps,
            template: { ...validProps.template, resources: { platform: 'cpu-e2', preset: '2vcpu-8gb' } },
          }),
        ),
      ).toBe(true)
      expect(
        Module.nodeGroupSpecDrifted(
          live,
          desiredFor({
            ...validProps,
            template: { ...validProps.template, networkInterfaces: [{ subnetId: 'vpcsubnet-2' }] },
          }),
        ),
      ).toBe(true)
      expect(
        Module.nodeGroupSpecDrifted(
          live,
          desiredFor({ ...validProps, template: { ...validProps.template, cloudInitUserData: '#cloud-config\n# changed' } }),
        ),
      ).toBe(true)
    })

    test('the publicIpAddress presence switch is compared as presence', () => {
      const live = nodeGroupProto().spec
      // live has no public address; the props ask for one → drift.
      expect(
        Module.nodeGroupSpecDrifted(
          live,
          desiredFor({
            ...validProps,
            template: { ...validProps.template, networkInterfaces: [{ subnetId: 'vpcsubnet-1', publicIpAddress: true }] },
          }),
        ),
      ).toBe(true)
      // The reverse — live has one, the props do not ask — cannot be cleared either, so it
      // must not loop.
      const withPublic = nodeGroupProto({
        spec: NebiusNodeGroupSchema.NodeGroupSpec.fromJSON({
          version: '1.35',
          fixedNodeCount: '2',
          template: {
            os: 'ubuntu24.04',
            resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
            bootDisk: { sizeGibibytes: '64', blockSizeBytes: '4096', type: 'NETWORK_SSD' },
            networkInterfaces: [{ subnetId: 'vpcsubnet-1', publicIpAddress: {} }],
            serviceAccountId: 'serviceaccount-abc123',
            cloudInitUserData: '#cloud-config\n',
          },
        }),
      })
      expect(Module.nodeGroupSpecDrifted(withPublic.spec, desiredFor(validProps))).toBe(false)
    })

    test('a live node group with no spec never drifts (nothing to compare)', () => {
      expect(Module.nodeGroupSpecDrifted(undefined, desiredFor(validProps))).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // arm 2 — autoscaling / strategy / autoRepair
  // -------------------------------------------------------------------------

  describe('arm 2 props (sizing, strategy, auto-repair)', () => {
    const autoProps = {
      ...validProps,
      fixedNodeCount: undefined,
      autoscaling: { minNodeCount: 1, maxNodeCount: 3 },
    }

    test('the desired spec carries a real Duration, not the JSON string form', () => {
      // The trap this pins: `Duration.fromJSON` accepts **only** `{seconds, nanos}` — the canonical
      // protobuf JSON string `"600s"` (what the CLI and the API's renderings emit) is silently
      // dropped, and the transfer provider shipped that bug. So assert on the built message.
      const spec = desiredFor({
        ...validProps,
        strategy: { maxUnavailable: { count: 1 }, drainTimeoutSeconds: 600 },
      })
      expect(spec.strategy!.drainTimeout!.seconds.toString()).toBe('600')
      expect(spec.strategy!.maxUnavailable!.count!.toString()).toBe('1')
      expect(spec.strategy!.maxUnavailable!.percent).toBeUndefined()
    })

    test('a percent and a count reach the wire on their own arms', () => {
      const spec = desiredFor({ ...validProps, strategy: { maxSurge: { percent: 25 } } })
      expect(spec.strategy!.maxSurge!.percent!.toString()).toBe('25')
      expect(spec.strategy!.maxSurge!.count).toBeUndefined()
    })

    test('autoRepair carries the condition status as the wire enum and its timeout as a Duration', () => {
      const spec = desiredFor({
        ...validProps,
        autoRepair: { conditions: [{ type: 'Ready', status: 'FALSE', timeoutSeconds: 300 }] },
      })
      // The string enum must be converted (`fromJSON`, not `fromPartial` — a string in an int32 field
      // serializes as NaN), and `FALSE` is 2.
      expect(spec.autoRepair!.conditions[0]!.status).toBe(NebiusNodeGroupSchema.ConditionStatus.FALSE)
      expect(spec.autoRepair!.conditions[0]!.timeout!.seconds.toString()).toBe('300')
    })

    test('the autoscaling block is built from both bounds', () => {
      const spec = desiredFor(autoProps)
      expect(spec.autoscaling!.minNodeCount.toString()).toBe('1')
      expect(spec.autoscaling!.maxNodeCount.toString()).toBe('3')
      // The swap is total: the pinned fixed count is gone from the request.
      expect(spec.fixedNodeCount).toBeUndefined()
    })

    test('a pinned strategy change drifts', () => {
      const live = nodeGroupProto().spec
      const news = { ...validProps, strategy: { maxUnavailable: { count: 2 } } }
      expect(Module.nodeGroupSpecDrifted(live, desiredFor(news as never))).toBe(true)
      // …and the same value against a live spec that holds it does not.
      const withStrategy = nodeGroupProto({
        spec: NebiusNodeGroupSchema.NodeGroupSpec.fromJSON({
          version: '1.35',
          fixedNodeCount: '2',
          strategy: { maxUnavailable: { count: '2' }, drainTimeout: { seconds: '600' } },
          template: {
            os: 'ubuntu24.04',
            resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
            bootDisk: { sizeGibibytes: '64', blockSizeBytes: '4096', type: 'NETWORK_SSD' },
            networkInterfaces: [{ subnetId: 'vpcsubnet-1' }],
            serviceAccountId: 'serviceaccount-abc123',
            cloudInitUserData: '#cloud-config\n',
          },
        }),
      })
      expect(Module.nodeGroupSpecDrifted(withStrategy.spec, desiredFor(news as never))).toBe(false)
    })

    test('an UNPINNED strategy is never compared — not from spec, and not from status', () => {
      // The resource's main drift hazard, measured 2026-09-23: with `strategy` omitted the API
      // reports its *effective* values in `status` (`maxUnavailable: {count: 1}`,
      // `maxSurge: {count: 0}`, `drainTimeout: 600s`) and those defaults are migrating during
      // Q3 2026. Comparing either would write on every reconcile, and never converge.
      const liveWithEcho = nodeGroupProto({
        spec: NebiusNodeGroupSchema.NodeGroupSpec.fromJSON({
          version: '1.35',
          fixedNodeCount: '2',
          // Even a `spec`-side echo must be invisible while nothing is pinned…
          strategy: { maxUnavailable: { count: '1' }, maxSurge: { count: '0' }, drainTimeout: { seconds: '600' } },
          template: {
            os: 'ubuntu24.04',
            resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
            bootDisk: { sizeGibibytes: '64', blockSizeBytes: '4096', type: 'NETWORK_SSD' },
            networkInterfaces: [{ subnetId: 'vpcsubnet-1' }],
            serviceAccountId: 'serviceaccount-abc123',
            cloudInitUserData: '#cloud-config\n',
          },
        }),
        // …and the effective values in status are not part of the comparison at all.
        status: {
          state: NebiusNodeGroupSchema.NodeGroupStatus_State.RUNNING,
          version: 'v1.36.3-nebius-node.75',
          targetNodeCount: Long.fromNumber(2),
          nodeCount: Long.fromNumber(2),
          readyNodeCount: Long.fromNumber(2),
          outdatedNodeCount: Long.fromNumber(0),
          events: [],
          strategy: NebiusNodeGroupSchema.NodeGroupDeploymentStrategy.fromJSON({
            maxUnavailable: { count: '1' },
            maxSurge: { count: '0' },
            drainTimeout: { seconds: '600' },
          }),
          reconciling: false,
        },
      })
      expect(Module.nodeGroupSpecDrifted(liveWithEcho.spec, desiredFor(validProps))).toBe(false)
    })

    test('a pinned drainTimeout that the live spec holds differently drifts', () => {
      const live = nodeGroupProto({
        spec: NebiusNodeGroupSchema.NodeGroupSpec.fromJSON({
          version: '1.35',
          fixedNodeCount: '2',
          strategy: { drainTimeout: { seconds: '600' } },
          template: {
            os: 'ubuntu24.04',
            resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
            bootDisk: { sizeGibibytes: '64', blockSizeBytes: '4096', type: 'NETWORK_SSD' },
            networkInterfaces: [{ subnetId: 'vpcsubnet-1' }],
            serviceAccountId: 'serviceaccount-abc123',
            cloudInitUserData: '#cloud-config\n',
          },
        }),
      })
      expect(
        Module.nodeGroupSpecDrifted(live.spec, desiredFor({ ...validProps, strategy: { drainTimeoutSeconds: 600 } })),
      ).toBe(false)
      expect(
        Module.nodeGroupSpecDrifted(live.spec, desiredFor({ ...validProps, strategy: { drainTimeoutSeconds: 900 } })),
      ).toBe(true)
    })

    test('autoRepair and autoscaling changes drift; an unpinned autoRepair does not', () => {
      const live = nodeGroupProto().spec
      expect(
        Module.nodeGroupSpecDrifted(
          live,
          desiredFor({
            ...validProps,
            autoRepair: { conditions: [{ type: 'Ready', status: 'FALSE' }] },
          }),
        ),
      ).toBe(true)
      // Live holds no autoRepair and none is pinned → nothing to compare.
      expect(Module.nodeGroupSpecDrifted(live, desiredFor(validProps))).toBe(false)
    })

    test('a live node group whose status differs wildly still does not drift', () => {
      // The comparison reads `spec` only — a node group mid-roll-out (`PROVISIONING`, 9 outdated
      // nodes, the API's own effective `status.strategy`) must be indistinguishable from an idle
      // `RUNNING` one when the props have not changed. If someone ever moves the drift list onto
      // `status`, this fails.
      const settled = nodeGroupProto()
      const midRollout = nodeGroupProto({
        status: {
          state: NebiusNodeGroupSchema.NodeGroupStatus_State.PROVISIONING,
          version: 'v1.36.0-nebius-node.1',
          targetNodeCount: Long.fromNumber(9),
          nodeCount: Long.fromNumber(0),
          readyNodeCount: Long.fromNumber(0),
          outdatedNodeCount: Long.fromNumber(9),
          events: [],
          strategy: NebiusNodeGroupSchema.NodeGroupDeploymentStrategy.fromJSON({ maxSurge: { percent: '50' } }),
          reconciling: true,
        },
      })
      const desired = desiredFor(validProps)
      expect(Module.nodeGroupSpecDrifted(settled.spec, desired)).toBe(false)
      expect(Module.nodeGroupSpecDrifted(midRollout.spec, desired)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // arm 4 — labels, taints, filesystems, local disks, preemptible, maxPods, reservations
  // -------------------------------------------------------------------------

  describe('arm 4 props (labels, taints, filesystems, local disks, preemptible, maxPods)', () => {
    /** A live spec built from `validProps`' template plus whatever the platform adds. */
    const liveWith = (template: Record<string, unknown> = {}, extraSpec: Record<string, unknown> = {}) =>
      nodeGroupProto({
        spec: NebiusNodeGroupSchema.NodeGroupSpec.fromJSON({
          version: '1.35',
          fixedNodeCount: '2',
          ...extraSpec,
          template: {
            os: 'ubuntu24.04',
            resources: { platform: 'cpu-d3', preset: '2vcpu-8gb' },
            bootDisk: { sizeGibibytes: '64', blockSizeBytes: '4096', type: 'NETWORK_SSD' },
            networkInterfaces: [{ subnetId: 'vpcsubnet-1' }],
            serviceAccountId: 'serviceaccount-abc123',
            cloudInitUserData: '#cloud-config\n',
            // The API's own echo for a field nobody pinned: measured live 2026-09-23, an omitted
            // `maxPods` comes back as `0` — the documented `110` default is *not* written into
            // `spec`. Kept in the fixture because an unpinned field with a value is exactly what a
            // whole-message comparison would trip over (and it is the case the 110-variant test
            // below makes stronger on purpose).
            maxPods: '0',
            ...template,
          },
        }),
      })

    test('the enum-valued props reach the wire as ints, not strings', () => {
      const spec = desiredFor({
        ...validProps,
        template: {
          ...validProps.template,
          taints: [{ key: 'dedicated', value: '', effect: 'NO_SCHEDULE' }],
          filesystems: [
            { attachMode: 'READ_WRITE', mountTag: 'data', existingFilesystem: { id: 'computefilesystem-1' } },
          ],
        },
      })
      // `fromJSON`, not `fromPartial`: a string in an int32 field serializes as NaN.
      expect(spec.template!.taints[0]!.effect).toBe(NebiusNodeGroupSchema.NodeTaint_Effect.NO_SCHEDULE)
      expect(spec.template!.taints[0]!.effect).toBe(2)
      expect(spec.template!.filesystems[0]!.attachMode).toBe(
        NebiusNodeGroupSchema.AttachedFilesystemSpec_AttachMode.READ_WRITE,
      )
      expect(spec.template!.filesystems[0]!.mountTag).toBe('data')
      expect(spec.template!.filesystems[0]!.existingFilesystem!.id).toBe('computefilesystem-1')
    })

    test('presence-shaped props are built as messages or booleans', () => {
      const spec = desiredFor({
        ...validProps,
        template: {
          ...validProps.template,
          preemptible: true,
          localDisks: { passthroughGroup: { requested: true }, config: { kubeletEphemeral: true } },
          maxPods: 110,
          reservationPolicy: { policy: 'STRICT', reservationIds: ['capacityblockgroup-1'] },
        },
      })
      // Preemptible is an **empty message**: presence is the switch, so `{}` is the whole payload.
      expect(spec.template!.preemptible).toEqual({})
      expect(spec.template!.localDisks!.passthroughGroup!.requested).toBe(true)
      expect(spec.template!.localDisks!.config!.kubeletEphemeral).toBe(true)
      expect(spec.template!.localDisks!.config!.none).toBeUndefined()
      expect(spec.template!.maxPods.toString()).toBe('110')
      expect(spec.template!.reservationPolicy!.policy).toBe(
        NebiusNodeGroupSchema.ReservationPolicy_Policy.STRICT,
      )
      expect(spec.template!.reservationPolicy!.reservationIds).toEqual(['capacityblockgroup-1'])
    })

    test('the two label maps stay distinct, and are copies', () => {
      const nodeLabels = { 'node-role': 'worker' }
      const spec = desiredFor({
        ...validProps,
        template: {
          ...validProps.template,
          metadata: { labels: nodeLabels },
          instanceMetadata: { labels: { team: 'platform' } },
        },
      })
      expect(spec.template!.metadata!.labels).toEqual({ 'node-role': 'worker' })
      expect(spec.template!.instanceMetadata!.labels).toEqual({ team: 'platform' })
      // A copy: mutating the props afterwards must not reach the message we already built.
      nodeLabels['node-role'] = 'changed'
      expect(spec.template!.metadata!.labels['node-role']).toBe('worker')
    })

    test('the platform-materialized maxPods cannot loop, but a pinned one is compared', () => {
      // The API's real echo keeps `0` here (measured live 2026-09-23) — no materialization. The
      // fixture deliberately uses the *stronger* hypothetical instead: even a platform that wrote
      // its documented `110` default into `spec` must not cause drift while nobody pinned it, which
      // is the property that makes this design different from a whole-message comparison.
      const materialized = liveWith({ maxPods: '110' })
      expect(Module.nodeGroupSpecDrifted(materialized.spec, desiredFor(validProps))).toBe(false)
      // The real shape too, for good measure.
      expect(Module.nodeGroupSpecDrifted(liveWith().spec, desiredFor(validProps))).toBe(false)
      // Pinned to the same value → still no drift…
      expect(
        Module.nodeGroupSpecDrifted(
          materialized.spec,
          desiredFor({ ...validProps, template: { ...validProps.template, maxPods: 110 } }),
        ),
      ).toBe(false)
      // …and pinned to a different one → drift, so the change is written.
      expect(
        Module.nodeGroupSpecDrifted(
          materialized.spec,
          desiredFor({ ...validProps, template: { ...validProps.template, maxPods: 64 } }),
        ),
      ).toBe(true)
    })

    test('labels compare by the keys the caller pinned, not whole-map', () => {
      // The platform adds its own node labels (`kubernetes.io/*`); a whole-map comparison would call
      // that drift on every reconcile.
      const live = liveWith({ metadata: { labels: { 'node-role': 'worker', 'kubernetes.io/hostname': 'n1' } } })
      expect(
        Module.nodeGroupSpecDrifted(
          live.spec,
          desiredFor({ ...validProps, template: { ...validProps.template, metadata: { labels: { 'node-role': 'worker' } } } }),
        ),
      ).toBe(false)
      // A pinned key whose value moved is real drift.
      expect(
        Module.nodeGroupSpecDrifted(
          live.spec,
          desiredFor({ ...validProps, template: { ...validProps.template, metadata: { labels: { 'node-role': 'gpu' } } } }),
        ),
      ).toBe(true)
    })

    test('taints, filesystems, preemptible, localDisks and reservations all drift when pinned', () => {
      const live = liveWith()
      const pinned = (template: Record<string, unknown>) =>
        Module.nodeGroupSpecDrifted(live.spec, desiredFor({ ...validProps, template: { ...validProps.template, ...template } }))

      expect(pinned({ taints: [{ key: 'dedicated', value: 'gpu', effect: 'NO_SCHEDULE' }] })).toBe(true)
      expect(
        pinned({
          filesystems: [
            { attachMode: 'READ_ONLY', mountTag: 'data', existingFilesystem: { id: 'computefilesystem-1' } },
          ],
        }),
      ).toBe(true)
      // Presence switch: live has none, the props ask for preemptible nodes.
      expect(pinned({ preemptible: true })).toBe(true)
      expect(pinned({ localDisks: { config: { none: true } } })).toBe(true)
      expect(pinned({ reservationPolicy: { policy: 'FORBID' } })).toBe(true)
      // Ids without a policy are the AUTO-with-preference case (and still a pinned change).
      expect(pinned({ reservationPolicy: { reservationIds: ['capacityblockgroup-1'] } })).toBe(true)
      // Nothing pinned → nothing compared, even though live carries the API's own echo values.
      expect(Module.nodeGroupSpecDrifted(live.spec, desiredFor(validProps))).toBe(false)
    })

    test('an unpinned preemptible echo cannot loop', () => {
      // The reverse direction: live has preemptible, the props do not ask for it (and it cannot be
      // turned off without recreating the group).
      const live = liveWith({ preemptible: {} })
      expect(Module.nodeGroupSpecDrifted(live.spec, desiredFor(validProps))).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Attributes
  // -------------------------------------------------------------------------

  describe('attributes', () => {
    test('reports the requested version and the running one separately', () => {
      // The two are *different formats*: `spec.version` is `<major>.<minor>` while
      // `status.version` is the node image's `v1.36.3-nebius-node.75` (**measured live
      // 2026-09-23**, leading `v` included). Nothing parses them together (see the note on
      // `versionValid`) — this pins both.
      const attrs = SchemaModule.toFriendlyAttributes(
        nodeGroupProto({
          status: {
            state: NebiusNodeGroupSchema.NodeGroupStatus_State.RUNNING,
            version: 'v1.36.3-nebius-node.75',
            targetNodeCount: Long.fromNumber(2),
            nodeCount: Long.fromNumber(2),
            readyNodeCount: Long.fromNumber(1),
            outdatedNodeCount: Long.fromNumber(1),
            events: [],
            reconciling: false,
          },
        }),
      )
      expect(attrs.requestedVersion).toBe('1.35')
      expect(attrs.version).toBe('v1.36.3-nebius-node.75')
      expect(attrs.state).toBe('RUNNING')
      // int64s arrive from decoded protobuf as `Long`s and must leave as decimal strings —
      // an attribute typed `Schema.Finite` for an int64 is a type that lies (a consumer
      // doing arithmetic silently concatenates).
      expect(attrs.fixedNodeCount).toBe('2')
      expect(attrs.targetNodeCount).toBe('2')
      expect(attrs.readyNodeCount).toBe('1')
      expect(attrs.outdatedNodeCount).toBe('1')
      expect(String(attrs.parentId)).toBe(CLUSTER_ID)
    })

    test('a node group with no status yet still maps', () => {
      const attrs = SchemaModule.toFriendlyAttributes(nodeGroupProto())
      expect(String(attrs.id)).toBe(NODE_GROUP_ID)
      expect(attrs.name).toBe('nodes-1')
      expect(attrs.version).toBeUndefined()
      expect(attrs.state).toBeUndefined()
      expect(attrs.reconciling).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Reconcile / delete
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    test('an unchanged baseline writes nothing', async () => {
      const svc = await resolveNodeGroupProvider()
      const writes: Array<unknown> = []
      await runReconcile(svc, validProps, { id: NODE_GROUP_ID }, validProps, Effect.provide(mocks(writes)) as never)
      expect(writes).toHaveLength(0)
    })

    test('a template change is written in place with the resource version', async () => {
      const svc = await resolveNodeGroupProvider()
      const writes: Array<unknown> = []
      await runReconcile(
        svc,
        { ...validProps, template: { ...validProps.template, os: 'ubuntu22.04' } },
        { id: NODE_GROUP_ID },
        validProps,
        Effect.provide(mocks(writes)) as never,
      )
      expect(writes).toHaveLength(1)
      const request = writes[0] as { metadata: { id: string; resourceVersion: string }; spec: unknown }
      expect(request.metadata.id).toBe(NODE_GROUP_ID)
      expect(request.metadata.resourceVersion).toBe('0')
    })

    test('a missing node group is created under its cluster, with internal labels', async () => {
      const svc = await resolveNodeGroupProvider()
      const writes: Array<unknown> = []
      const layer = base(
        mockMk8sLayer({
          nodeGroup: {
            get: () => Effect.fail(notFoundError()),
            create: (req: unknown) => {
              writes.push(req)
              return Effect.succeed(nodeGroupProto())
            },
          },
        }),
      )
      await runReconcile(svc, validProps, { id: NODE_GROUP_ID }, validProps, Effect.provide(layer) as never)
      expect(writes).toHaveLength(1)
      const request = writes[0] as { metadata: { parentId: string; name: string; labels: Record<string, string> } }
      // The parent is the **cluster** — not the configured project.
      expect(request.metadata.parentId).toBe(CLUSTER_ID)
      expect(request.metadata.name).toBe('nodes-1')
      expect(Object.keys(request.metadata.labels).length).toBeGreaterThan(0)
    })

    test('delete tolerates NOT_FOUND', async () => {
      // Not hygiene here: a Cluster delete cascades to its node groups (measured
      // 2026-09-23), so a node group's delete legitimately finds nothing.
      const svc = await resolveNodeGroupProvider()
      const layer = base(
        mockMk8sLayer({
          nodeGroup: { delete: () => Effect.fail(notFoundError()) },
        }),
      )
      await runDelete(svc, { id: NODE_GROUP_ID }, validProps, Effect.provide(layer) as never)
    })
  })

  // -------------------------------------------------------------------------
  // diff — the replace set (the convergence table pins the shapes too)
  // -------------------------------------------------------------------------

  describe('diff', () => {
    test('a parent change replaces create-first (a different cluster is a different identity)', async () => {
      expect(
        await runDiff(await resolveNodeGroupProvider(), { ...validProps, parentId: 'mk8scluster-2' }, validProps),
      ).toEqual({ action: 'replace' })
    })

    test('a name change replaces (a different physical name)', async () => {
      expect(await runDiff(await resolveNodeGroupProvider(), { ...validProps, name: 'nodes-2' }, validProps)).toEqual({
        action: 'replace',
      })
    })

    test('arm 1 has no create-only spec field: template and sizing changes plan an update', async () => {
      // Unlike the Cluster (subnetId, serviceCidrs) the whole node template is updatable in
      // place — the API applies template changes as a roll-out per the deployment strategy —
      // so `diff` must NOT replace here. `undefined` lets the framework plan `update`,
      // which is what runs `reconcile`.
      expect(
        await runDiff(
          await resolveNodeGroupProvider(),
          { ...validProps, template: { ...validProps.template, os: 'ubuntu22.04' } },
          validProps,
        ),
      ).toBeUndefined()
      expect(await runDiff(await resolveNodeGroupProvider(), { ...validProps, version: '1.34' }, validProps)).toBeUndefined()
      expect(await runDiff(await resolveNodeGroupProvider(), { ...validProps, fixedNodeCount: 3 }, validProps)).toBeUndefined()
    })

    test('invalid props are rejected at plan time', async () => {
      // Through `runDiff` rather than a hand-built input: the provider's `diff` input is
      // typed against the resource's own props, and `resolveProvider` hands back exactly that
      // signature — so the assertion is "a plan-time rejection happens", not a cast.
      const provider = await resolveNodeGroupProvider()
      const rejection = await runDiff(provider, { ...validProps, fixedNodeCount: 0 }, validProps).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(String(rejection)).toContain('fixedNodeCount')
    })
  })
})
