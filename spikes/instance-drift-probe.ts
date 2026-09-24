/**
 * The `compute/v1 Instance` **drift-loop** probe (2026-09-24).
 *
 * The loop it measures is a live-echo bug: an unchanged re-deploy still planned and wrote an update,
 * because `instanceSpecDrifted` compared whole messages against a live spec the platform had filled in
 * (`bootDisk.managedDisk.spec.diskEncryption = {}`, `labels = {}`, an auto-allocated `ipAddress`, …).
 * A unit test cannot see it (every mocked `live` is built from the props the provider itself sent), and the
 * two existing instance live tests only create and delete — so this probe is the oracle:
 *
 *   bun alchemy deploy spikes/instance-drift-probe.ts --yes        # 1. create  → resourceVersion 1
 *   bun alchemy deploy spikes/instance-drift-probe.ts --yes        # 2. idle    → MUST write nothing
 *   bun spikes/instance-drift-diagnose.ts                          # 3. which branch fires, if any
 *   bun alchemy deploy spikes/instance-drift-probe.ts --yes        # 4. after a real change (PROBE_HOSTNAME)
 *   bun alchemy destroy spikes/instance-drift-probe.ts --yes
 *
 * Step 2 is the loop witness (`resourceVersion` staying at `1` — for `compute/v1` it *is* a per-resource
 * write counter; see the calibration table in AGENTS.md), step 3 is the branch-level witness, and step 4 is
 * the **positive control**: a fix that simply stopped comparing things would also make step 2 pass, and this
 * is what proves a real change still converges. `PROBE_DROP_SECONDARY=1` runs the removal arm (drop the
 * data disk from the props) — the one comparison whose semantics are *not* settleable from the proto.
 */
import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

import { probeInstanceProps } from './instance-drift-probe-props.ts'

export interface StackOutput {
  instanceId: Nebius.compute.InstanceId
  state: string
}

export default Alchemy.Stack(
  'InstanceDriftProbe',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const instance = yield* Nebius.compute.Instance('DriftVm', probeInstanceProps())

    return {
      instanceId: instance.id,
      state: instance.state,
    }
  }),
)
