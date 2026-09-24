/**
 * The `compute/v1 Instance` props shared by the drift probe stack and its diagnosis script.
 *
 * One module on purpose: the diagnosis is only meaningful if it rebuilds the **same `desired`** the
 * deployed provider built. Two copies of these props would make "no drift" as likely to mean "the probe
 * deployed something else".
 *
 * The shape is chosen to exercise every comparison the drift list can make against a **real VM**, because
 * the loop being diagnosed is a *live-echo* bug (the platform materializes fields the props never carried):
 *
 *  * `bootDisk` pins `managedDisk.name` and a spec, leaving the disk's `labels`/`diskEncryption` to the
 *    platform — the measured culprits;
 *  * an unpinned `hostname` and `recoveryPolicy` (the platform's own defaults), which is the other half;
 *  * one more **network interface** and one **secondary disk** so the repeated-field comparisons
 *    (`pinnedListDrifted`) see live materialization too, not just an empty list;
 *  * pinned `cloudInitUserData` on purpose: the provider always sends merged user-data, so an unpinned one
 *    would be compared against `""` and fire for an unrelated reason.
 */
import * as Nebius from '@fllstck/nebius-alchemy'
import type * as InstanceSchema from '../modules/resources/compute/v1/instance.schema.ts'

export const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
/** The pre-existing default subnet (see the 2026-09-23 probes). */
export const SUBNET_ID = process.env.NEBIUS_SUBNET_ID ?? 'vpcsubnet-e00rf5t1vkbq0ew96x'
export const SERVICE_ACCOUNT_ID = process.env.NEBIUS_SA_ID ?? 'serviceaccount-e00r4d1ae86rb4n03a'
export const INSTANCE_NAME = process.env.PROBE_INSTANCE_NAME ?? 'alchemy-instance-drift-probe'

/**
 * The props, as a plain function (not a literal) so the diagnose script can call it without a stack.
 *
 * `hostname`/`recoveryPolicy` are deliberately **absent** by default: an unpinned optional scalar is how a
 * user's ordinary config looks, and it is where a comparison against the platform's own default would loop.
 */
export const probeInstanceProps = (overrides: Partial<InstanceSchema.InstanceProps> = probeOverrides()) =>
  ({
    // No `parentId`: the provider falls back to `NEBIUS_PROJECT_ID` (the stack's config), and a branded
    // literal here would only be noise in a module that exists to describe a spec.
    name: INSTANCE_NAME,
    serviceAccountId: Nebius.iam.ServiceAccountId.make(SERVICE_ACCOUNT_ID),
    resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
    bootDisk: {
      attachMode: 'READ_WRITE',
      managedDisk: {
        name: 'alchemy-instance-drift-boot',
        spec: {
          type: 'NETWORK_SSD',
          sizeGibibytes: 64,
          sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
        },
      },
    },
    secondaryDisks: [
      {
        attachMode: 'READ_WRITE',
        // Blank on purpose (no source image): a fresh data volume — and the array the
        // `secondaryDisks` comparison has to survive, since a disk comes back with platform-filled
        // fields of its own.
        managedDisk: { name: 'alchemy-instance-drift-data', spec: { type: 'NETWORK_SSD', sizeGibibytes: 128 } },
      },
    ],
    filesystems: [],
    networkInterfaces: [
      {
        subnetId: Nebius.vpc.SubnetId.make(SUBNET_ID),
        name: 'eth0',
        ipAddress: { allocationId: '' },
      },
    ],
    cloudInitUserData: '#cloud-config\n# instance drift probe\n',
    ...overrides,
  }) satisfies InstanceSchema.InstanceProps

/**
 * The environment's arms, read by **both** the stack and the diagnose script — the reason they are a
 * function rather than two copies of the same `process.env` tests: the diagnosis is only meaningful when it
 * rebuilds the props the deployed generation actually used, and a mismatch (running the diagnose without
 * `PROBE_HOSTNAME`) reads as drift that is real for the props the script built, not for the VM. (That
 * happened: a diagnosis run without the env var reported the pinned `hostname` as drift, correctly for its
 * own `desired` and useless as evidence.)
 */
export const probeOverrides = (): Partial<InstanceSchema.InstanceProps> => ({
  ...(process.env.PROBE_HOSTNAME === undefined ? {} : { hostname: process.env.PROBE_HOSTNAME }),
  ...(process.env.PROBE_DROP_SECONDARY === '1' ? { secondaryDisks: [] } : {}),
})
