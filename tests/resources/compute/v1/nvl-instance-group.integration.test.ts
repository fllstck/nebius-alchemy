import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'
/**
 * ⚠️ UNVERIFIED against real infra. An NVLink instance group is GB200/GB300
 * rack hardware: creating one needs (a) the NVLink platform entitlement in the
 * project and (b) quota for the rack, neither of which the test environment is
 * known to have. It is written and gated rather than omitted so that the
 * provider's lifecycle is verifiable the moment that entitlement exists.
 *
 *   NEBIUS_TEST_NVL_GROUP=1 SLOW_TESTS=1 \
 *   bun test tests/resources/compute/v1/nvl-instance-group.integration.test.ts
 *
 * Beyond `SLOW_TESTS` it needs that explicit opt-in, so a routine integration
 * run does not fail on a quota error it cannot do anything about.
 *
 * Until then, every claim about this provider rests on the unit tests + the
 * generated proto, not on a live deploy.
 */
const ENABLED = process.env.NEBIUS_TEST_NVL_GROUP === '1'

integrationTest(
  test.provider,
  'Nebius.compute.v1.NVLInstanceGroup lifecycle (create → grow size → destroy)',
  (stack) =>
    Effect.gen(function* () {
      const group = yield* stack.deploy(Nebius.compute.NVLInstanceGroup('LifecycleTest', { type: 'GB200', size: 1 }))

      expect(group.id).toBeDefined()
      expect(group.name).toBeDefined()
      expect(group.type).toBe('GB200')
      // int64 on the wire; the JSON form the attributes carry is a decimal string.
      expect(String(group.size)).toBe('1')
      // No members: nothing has joined the group (membership is set on the Instance).
      expect(Object.keys(group.instances ?? {})).toEqual([])

      // `size` is the one in-place-adjustable field — growing it must not replace.
      const grown = yield* stack.deploy(Nebius.compute.NVLInstanceGroup('LifecycleTest', { type: 'GB200', size: 2 }))
      expect(grown.id).toBe(group.id)
      expect(String(grown.size)).toBe('2')
    }).pipe(safeDestroy(stack)),
  { timeout: 240_000 },
  ENABLED,
)
