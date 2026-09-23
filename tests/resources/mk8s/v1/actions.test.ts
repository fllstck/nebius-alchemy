import * as BunTest from 'bun:test'

import {
  toCompatibilityRows,
  toControlPlaneVersionRows,
} from '../../../../modules/resources/mk8s/v1/actions.ts'
import type { ClusterControlPlaneVersion } from '../../../../schemas/nebius/mk8s/v1/cluster_service.ts'
import type { NodeGroupCompatibilityMatrix } from '../../../../schemas/nebius/mk8s/v1/node_group_service.ts'

const { describe, expect, test } = BunTest

/**
 * The mk8s **discovery actions** — the authority behind `NodeGroup.template.os`,
 * `template.resources` and both resources' `version`.
 *
 * Only the shaping is testable: an `Alchemy.Action` resolves through the stack and
 * cannot be called standalone (the same reason `capacity/v1`'s filters are exported and
 * unit-tested). That shaping is where the mistakes live — leaking a decoded `Date` out of
 * an action, and treating an empty `driversPreset` (the CPU-image answer) as missing.
 */
describe('Nebius.mk8s actions', () => {
  test('the version catalogue is mapped without leaking a Date', () => {
    const rows: ReadonlyArray<ClusterControlPlaneVersion> = [
      { version: '1.36', restricted: false, deprecated: false, endOfLife: new Date('2027-03-01T00:00:00Z') },
      // The common case: no end-of-life announced yet — the field is absent, not empty.
      { version: '1.35', restricted: false, deprecated: true, endOfLife: undefined },
      { version: '1.37', restricted: true, deprecated: false, endOfLife: undefined },
    ]

    expect(toControlPlaneVersionRows(rows)).toEqual([
      { version: '1.36', restricted: false, deprecated: false, endOfLife: '2027-03-01T00:00:00.000Z' },
      { version: '1.35', restricted: false, deprecated: true, endOfLife: undefined },
      { version: '1.37', restricted: true, deprecated: false, endOfLife: undefined },
    ])
  })

  test('the compatibility matrix keeps an empty driversPreset (the CPU answer)', () => {
    // Measured 2026-09-23: `1.31` + `gpu-h200-sxm` answered one row with an empty preset and
    // a second with `cuda12.8`. An empty preset means "no preinstalled drivers", which is
    // exactly what a CPU node group wants — dropping or defaulting it would make the row
    // unauthorable.
    const matrix: NodeGroupCompatibilityMatrix = {
      versions: [
        {
          kubernetesVersion: '1.31',
          items: [
            { os: 'ubuntu24.04', driversPreset: '', compatiblePlatforms: ['gpu-h200-sxm'] },
            { os: 'ubuntu24.04', driversPreset: 'cuda12.8', compatiblePlatforms: ['gpu-h200-sxm'] },
          ],
        },
      ],
    }

    expect(toCompatibilityRows(matrix)).toEqual([
      {
        kubernetesVersion: '1.31',
        items: [
          { os: 'ubuntu24.04', driversPreset: '', compatiblePlatforms: ['gpu-h200-sxm'] },
          { os: 'ubuntu24.04', driversPreset: 'cuda12.8', compatiblePlatforms: ['gpu-h200-sxm'] },
        ],
      },
    ])
  })

  test('the platform list is copied, so a caller cannot mutate the response', () => {
    const platforms = ['cpu-d3']
    const rows = toCompatibilityRows({
      versions: [{ kubernetesVersion: '1.36', items: [{ os: 'ubuntu24.04', driversPreset: '', compatiblePlatforms: platforms }] }],
    })
    expect(rows[0]!.items[0]!.compatiblePlatforms).not.toBe(platforms)
  })
})
